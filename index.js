const pulumi = require("@pulumi/pulumi");
const aws = require("@pulumi/aws");

// Retrieve configuration and secrets.
const config = new pulumi.Config();

function applyTags(additionalTags = {}) {
    let tags = { "Name": pulumi.getProject(), "Type": pulumi.getStack() };
    return { ...tags, ...additionalTags };
}

// Create a VPC, internet gateway, subnets, and route tables

const vpc = new aws.ec2.Vpc("my-vpc", {
    cidrBlock: "10.0.0.0/16",
    tags: applyTags({ "Resource": "VPC" }),
});

const ig = new aws.ec2.InternetGateway("my-ig", {
    vpcId: vpc.id,
    tags: applyTags({ "Resource": "InternetGateway" }),
});

aws.getAvailabilityZones().then(azs => {
    const maxAzs = 3;
    const azsToUse = azs.names.slice(0, maxAzs);

    const publicSubnets = [];
    const privateSubnets = [];
    for (let i = 0; i < azsToUse.length; i++) {
        publicSubnets.push(new aws.ec2.Subnet(`my-public-subnet-${i+1}`, {
            vpcId: vpc.id,
            cidrBlock: `10.0.${i+1}.0/24`,
            availabilityZone: azsToUse[i],
            mapPublicIpOnLaunch: true,
            tags: applyTags({ "Name": `Public subnet ${i+1}`, "Zone": "public" }),
        }));

        privateSubnets.push(new aws.ec2.Subnet(`my-private-subnet-${i+1}`, {
            vpcId: vpc.id,
            cidrBlock: `10.0.${i+100}.0/24`,
            availabilityZone: azsToUse[i],
            tags: applyTags({ "Name": `Private subnet ${i+1}`, "Zone": "private" }),
        }));
    }

   // Load Balancer Security Group
   const loadBalancerSg = new aws.ec2.SecurityGroup("lb-sg", {
    vpcId: vpc.id,
    description: "Load balancer security group",
    ingress: [
        { protocol: "tcp", fromPort: 80, toPort: 80, cidrBlocks: ["0.0.0.0/0"] },
        { protocol: "tcp", fromPort: 443, toPort: 443, cidrBlocks: ["0.0.0.0/0"] }
    ],
    egress: [
        { protocol: "-1", fromPort: 0, toPort: 0, cidrBlocks: ["0.0.0.0/0"] }
    ],
    tags: applyTags({ "Name": "LoadBalancerSG" }),
});

// App Security Group - Updated to restrict access to the instance from the internet and allow traffic from the Load Balancer Security Group
const appSecurityGroup = new aws.ec2.SecurityGroup("app-sg", {
    vpcId: vpc.id,
    description: "Allow inbound SSH and custom application traffic from Load Balancer",
    ingress: [
        // Allows SSH access
        { protocol: "tcp", fromPort: 22, toPort: 22, securityGroups: [loadBalancerSg.id] },
        // Allows application traffic on the port your application runs
        { protocol: "tcp", fromPort: 8080, toPort: 8080, securityGroups: [loadBalancerSg.id] },
    ],
    egress: [
        // Egress to allow everything out
        { protocol: "-1", fromPort: 0, toPort: 0, cidrBlocks: ["0.0.0.0/0"] },
    ],
    tags: applyTags({ "Name": "AppSecurityGroup" }),
});

    const dbSecurityGroup = new aws.ec2.SecurityGroup("db-sg", {
        vpcId: vpc.id,
        description: "Allow inbound MySQL traffic",
        ingress: [
            { protocol: "tcp", fromPort: 3306, toPort: 3306, securityGroups: [appSecurityGroup.id] }
        ],        
        egress: [{ protocol: "-1", fromPort: 0, toPort: 0, cidrBlocks: ["0.0.0.0/0"] }],
        tags: applyTags({ "Name": "DbSecurityGroup" }),
    });

    publicSubnets.forEach((subnet, index) => {
        const routeTable = new aws.ec2.RouteTable(`public-rt-${index}`, {
            vpcId: vpc.id,
            routes: [{
                cidrBlock: "0.0.0.0/0",
                gatewayId: ig.id
            }],
            tags: applyTags({ "Name": `Public Route Table ${index}` }),
        });

        new aws.ec2.RouteTableAssociation(`public-rta-${index}`, {
            subnetId: subnet.id,
            routeTableId: routeTable.id,
        });
    });

    privateSubnets.forEach((subnet, index) => {
        const routeTable = new aws.ec2.RouteTable(`private-rt-${index}`, {
            vpcId: vpc.id,
            tags: applyTags({ "Name": `Private Route Table ${index}` }),
        });

        new aws.ec2.RouteTableAssociation(`private-rta-${index}`, {
            subnetId: subnet.id,
            routeTableId: routeTable.id,
        });
    });

    const dbSubnetGroup = new aws.rds.SubnetGroup("db-subnet-group", {
        subnetIds: privateSubnets.map(subnet => subnet.id),
        tags: applyTags({ "Resource": "DBSubnetGroup" }),
    });

    const dbParameterGroup = new aws.rds.ParameterGroup("my-db-param-group", {
        family: "mysql8.0",
        parameters: [{ name: "character_set_client", value: "utf8" }],
        tags: applyTags({ "Resource": "DbParameterGroup" }),
    });

// IAM role and policy for EC2 instances

const ec2Role = new aws.iam.Role("ec2-role", {
    assumeRolePolicy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [{
            Action: "sts:AssumeRole",
            Effect: "Allow",
            Principal: {
                Service: "ec2.amazonaws.com"
            }
        }],
    }),
    tags: applyTags({ "Resource": "EC2Role" }),
});

const ec2Policy = new aws.iam.Policy("ec2-policy", {
    policy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
            {
                Effect: "Allow",
                Action: [
                    "logs:CreateLogGroup",
                    "logs:CreateLogStream",
                    "logs:PutLogEvents",
                    "logs:DescribeLogStreams",
                    "cloudwatch:PutMetricData",
                    "cloudwatch:GetMetricData",
                    "cloudwatch:GetMetricStatistics",
                    "cloudwatch:ListMetrics",
                    "ec2:DescribeTags",
                    "ec2:DescribeInstances",
                    "ec2:DescribeInstanceStatus",
                    // Add other necessary permissions for your EC2 instances
                ],
                Resource: "*"
            },
        ],
    }),
    description: "Policy for EC2 instances",
});

const ec2PolicyAttachment = new aws.iam.RolePolicyAttachment("ec2-policy-attachment", {
    role: ec2Role.name,
    policyArn: ec2Policy.arn,
});

// Create an IAM instance profile for EC2
const instanceProfile = new aws.iam.InstanceProfile("ec2-instance-profile", {
    role: ec2Role.name,
});

// Auto Scaling Role and Policy
const autoScalingRole = new aws.iam.Role("autoScalingRole", {
    assumeRolePolicy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [{
            Effect: "Allow",
            Principal: {
                Service: "autoscaling.amazonaws.com",
            },
            Action: "sts:AssumeRole",
        }],
    }),
    tags: applyTags({ "Resource": "AutoScalingRole" }),
});

const autoScalingPolicy = new aws.iam.Policy("autoScalingPolicy", {
    description: "A policy for Auto Scaling access",
    policy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
            {
                Effect: "Allow",
                Action: [
                    "autoscaling:Describe*",
                    "autoscaling:SetDesiredCapacity",
                    "autoscaling:TerminateInstanceInAutoScalingGroup",
                    "autoscaling:PutScalingPolicy",
                    // Additional Auto Scaling-related permissions
                ],
                Resource: "*",
            },
        ],
    }),
});


// Load Balancer Role and Policy
const loadBalancerRole = new aws.iam.Role("loadBalancerRole", {
    assumeRolePolicy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [{
            Effect: "Allow",
            Principal: {
                Service: "elasticloadbalancing.amazonaws.com",
            },
            Action: "sts:AssumeRole",
        }],
    }),
    tags: applyTags({ "Resource": "LoadBalancerRole" }),
});

const loadBalancerPolicy = new aws.iam.Policy("loadBalancerPolicy", {
    description: "A policy for Load Balancer access",
    policy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
            {
                Effect: "Allow",
                Action: [
                    "elasticloadbalancing:Describe*",
                    "elasticloadbalancing:AddTags",
                    "elasticloadbalancing:CreateLoadBalancer",
                    "elasticloadbalancing:RegisterTargets",
                    // Additional Elastic Load Balancing-related permissions
                ],
                Resource: "*",
            },
        ],
    }),
});

const loadBalancerRolePolicyAttachment = new aws.iam.RolePolicyAttachment("loadBalancerRolePolicyAttachment", {
    role: loadBalancerRole,
    policyArn: loadBalancerPolicy.arn,
})
//   // Attach the AWS managed CloudWatchAgentServerPolicy to the role
//   const ec2PolicyAttachment = new aws.iam.RolePolicyAttachment("ec2-policy-attachment", {
//     role: ec2Role.name,
//     policyArn: ec2Policy.arn,
// });

// Create an RDS instance
 const dbInstance = new aws.rds.Instance("csye6225-db", {
        engine: "mysql",
        instanceClass: "db.t2.micro",
        allocatedStorage: 20,
        storageType: "gp2",
        name: "csye6225",
        username: "csye6225",
        password: "root1234",
        parameterGroupName: dbParameterGroup.name,
        skipFinalSnapshot: true,
        vpcSecurityGroupIds: [dbSecurityGroup.id],
        dbSubnetGroupName: dbSubnetGroup.name,
        tags: applyTags({ "Resource": "RDSInstance" }),
    });

   // Create EC2 instance
 const ec2Instance = new aws.ec2.Instance("app-instance", {
        instanceType: "t2.micro",
        ami: "ami-01baf45938fd8c54e", // Replace with your AMI ID
        keyName: "ec2-key",
        subnetId: publicSubnets[0].id,
        vpcSecurityGroupIds: [appSecurityGroup.id],
        associatePublicIpAddress: true,
        iamInstanceProfile: instanceProfile.name,
        userData: pulumi.interpolate`#!/bin/bash
        echo "NODE_ENV=production" >> /etc/environment
        endpoint=${dbInstance.endpoint}
        echo "DB_HOST=\${endpoint%:*}" >> /etc/environment
        echo DB_USERNAME=csye6225 >> /etc/environment
        echo DB_PASSWORD=root1234 >> /etc/environment
        echo DB_DATABASE=csye6225 >> /etc/environment
        # Commands for installing and starting CloudWatch Agent
    `,
    tags: applyTags({ "Name": "web-server-instance" }),
}, { dependsOn: [ec2PolicyAttachment] }); // Ensure that the EC2 instance is created after the policy attachment

// Define Load Balancer
const elb = new aws.elb.LoadBalancer("my-load-balancer", {
    subnets: publicSubnets.map(subnet => subnet.id),
    securityGroups: [loadBalancerSg.id],
    listeners: [{
        instancePort: 8080, // Port where the instance is listening
        instanceProtocol: "http",
        lbPort: 8080, // Port where the Load Balancer is listening
        lbProtocol: "http",
    }],
    healthCheck: {
        target: "HTTP:8080/healthz", // Health check path and port
        interval: 30,
        healthyThreshold: 2,
        unhealthyThreshold: 2,
        timeout: 3,
    },
    instances: [ec2Instance.id], // Assuming `ec2Instance` is the correct reference 
    tags: applyTags({ "Name": "my-load-balancer" }),
}, { dependsOn: [ec2Instance] }); // Make sure `ec2Instance` is declared and defined before this
   
   
    const zone = pulumi.output(aws.route53.getZone({ name: "demo.awswebapp.tech" })); // Replace with your domain
    const domainName = ""; // Replace with your actual domain name

    const record = new aws.route53.Record("app-a-record", {
        zoneId: zone.id,
        name: domainName, 
        type: "A",
        ttl: 60,
        records: [ec2Instance.publicIp],
    }, { dependsOn: [ec2Instance] }); // Ensure that the A record is created after the EC2 instance
    
    exports.instanceDnsName = ec2Instance.publicDns,
    exports.loadBalancerDnsName = elb.dnsName;});

    