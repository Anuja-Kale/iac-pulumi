const pulumi = require("@pulumi/pulumi");
const aws = require("@pulumi/aws");
const gcp = require("@pulumi/gcp");
const mailgun = require("@pulumi/mailgun");

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

  // Create a Load Balancer Security Group.
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
    description: "Allow inbound traffic only from the Load Balancer",
    ingress: [
        {
            protocol: "tcp",
            fromPort: 8080, // Your application's port
            toPort: 8080, // Your application's port
            securityGroups: [loadBalancerSg.id], // Allow access only from Load Balancer's security group
        },
            {
              fromPort: 22,
              toPort: 22,
              protocol: "tcp",
              cidrBlocks: ["0.0.0.0/0"], // Allow SSH from anywhere
            },
    ],
    egress: [
        { protocol: "-1", fromPort: 0, toPort: 0, cidrBlocks: ["0.0.0.0/0"] },
    ],
    tags: applyTags({ "Name": "AppSecurityGroup" }),
});

   // Create a Database Security Group.
    const dbSecurityGroup = new aws.ec2.SecurityGroup("db-sg", {
        vpcId: vpc.id,
        description: "Allow inbound MySQL traffic",
        ingress: [
            { protocol: "tcp", fromPort: 3306, toPort: 3306, securityGroups: [appSecurityGroup.id] }
        ],        
        egress: [{ protocol: "-1", fromPort: 0, toPort: 0, cidrBlocks: ["0.0.0.0/0"] }],
        tags: applyTags({ "Name": "DbSecurityGroup" }),
    });

     // Create an RDS Subnet Group.
     const dbSubnetGroup = new aws.rds.SubnetGroup("db-subnet-group", {
        subnetIds: privateSubnets.map(subnet => subnet.id),
        tags: applyTags({ "Resource": "DBSubnetGroup" }),
    });
   
    // Create an RDS Parameter Group.
    const dbParameterGroup = new aws.rds.ParameterGroup("my-db-param-group", {
        family: "mysql8.0",
        parameters: [{ name: "character_set_client", value: "utf8" }],
        tags: applyTags({ "Resource": "DbParameterGroup" }),
    });

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


    
    // Create route tables for public subnets.
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

    // Create route tables for private subnets.
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

    // Create an Amazon SNS topic
const snsTopic = new aws.sns.Topic("my-sns-topic", {
    displayName: "webapp-notifications", // A user-friendly name for the SNS topic
    tags: applyTags({ "Resource": "SNSTopic" }),
});

// Export the ARN of the SNS topic
exports.snsTopicArn = snsTopic.arn;

// Create an IAM role for EC2 instances.
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

// Attach the IAM policy to the role.
const ec2PolicyAttachment = new aws.iam.RolePolicyAttachment("ec2-policy-attachment", {
    role: ec2Role.name,
    policyArn: ec2Policy.arn,
});

// Create an IAM instance profile for EC2 instances.
const instanceProfile = new aws.iam.InstanceProfile("ec2-instance-profile", {
    role: ec2Role.name,
});

// // User Data Script
// const userData = `#!/bin/bash
// echo "NODE_ENV=production" >> /etc/environment
// endpoint=${dbInstance.endpoint}
// echo "DB_HOST=\${endpoint%:*}" >> /etc/environment
// echo DB_USERNAME=csye6225 >> /etc/environment
// echo DB_PASSWORD=root1234 >> /etc/environment
// echo DB_DATABASE=csye6225 >> /etc/environment
// # Add your application setup and launch commands here
// `;

//const encodedUserData = Buffer.from(userData).toString('base64');

// Launch Template instead of Launch Configuration
const launchTemplate = new aws.ec2.LaunchTemplate("my-launch-template", {
    imageId: "ami-0b9be03711aff4b51", // Replace with your AMI ID
    instanceType: "t2.micro",
    keyName: "ec2-key",
    networkInterfaces: [{
        associatePublicIpAddress: true,
        securityGroups: [appSecurityGroup.id],
    }],
    userData: pulumi.interpolate`#!/bin/bash
    echo "NODE_ENV=production" >> /etc/environment
    endpoint="${dbInstance.endpoint}"
    echo "DB_HOST=\${endpoint%:*}" >> /etc/environment
    echo DB_USERNAME=csye6225 >> /etc/environment
    echo DB_PASSWORD=root1234 >> /etc/environment
    echo DB_DATABASE=csye6225 >> /etc/environment
    sudo systemctl start webapp
    sudo systemctl restart amazon-cloudwatch-agent
  `.apply((s) => Buffer.from(s).toString("base64")),

    iamInstanceProfile: {
        arn: instanceProfile.arn,
    },
    tagSpecifications: [{
        resourceType: "instance",
        tags: applyTags({ "Name": "web-server-instance" }),
    }],
});

// Application Load Balancer (ALB)
const alb = new aws.lb.LoadBalancer("app-load-balancer", {
    subnets: publicSubnets.map(subnet => subnet.id),
    securityGroups: [loadBalancerSg.id],
    loadBalancerType: "application", // Specify the type as 'application'
    tags: applyTags({ "Name": "app-load-balancer" }),
});


// const elb = new aws.elb.LoadBalancer("my-load-balancer", {
//     subnets: publicSubnets.map(subnet => subnet.id),
//     securityGroups: [loadBalancerSg.id],
//     listeners: [{
//         instancePort: 8080,
//         instanceProtocol: "http",
//         lbPort: 8080,
//         lbProtocol: "http",
//     }],
//     healthCheck: {
//         target: "HTTP:8080/healthz",
//         interval: 30,
//         healthyThreshold: 2,
//         unhealthyThreshold: 2,
//         timeout: 3,
//     },
//     tags: applyTags({ "Name": "my-load-balancer" }),
// });


// Target Group
const targetGroup = new aws.lb.TargetGroup("app-target-group", {
    port: 8080,
    protocol: "HTTP",
    vpcId: vpc.id,
    targetType: "instance",
    healthCheck: {
        enabled: true,
        path: "/healthz",
        port: "8080",
        protocol: "HTTP",
        healthyThreshold: 3,
        unhealthyThreshold: 5,
        timeout: 5,
        interval: 30,
        matcher: "200",
    },
    tags: applyTags({ "Name": "app-target-group" }),
});


// Listener
const listener = new aws.lb.Listener("app-listener", {
    loadBalancerArn: alb.arn,
    port: 80,
    protocol: "HTTP",
    defaultActions: [{
        type: "forward",
        targetGroupArn: targetGroup.arn,
    }],
});

// Create an Auto Scaling Group using the launch template
const autoScalingGroup = new aws.autoscaling.Group("my-auto-scaling-group", {
    vpcZoneIdentifiers: publicSubnets.map(subnet => subnet.id),
    launchTemplate: {
        id: launchTemplate.id,
        version: "$Latest"
    },
    minSize: 1,
    maxSize: 3,
    desiredCapacity: 1,
    targetGroupArns: [targetGroup.arn],
    tags: [{
        key: "Name",
        value: "web-server-instance",
        propagateAtLaunch: true,
    }],
}, { dependsOn: [listener] }); // Depend on the listener, not the ELB

// Create scaling policies for the Auto Scaling Group.
const scaleUpPolicy = new aws.autoscaling.Policy("scale-up", {
    scalingAdjustment: 1,
    adjustmentType: "ChangeInCapacity",
    cooldown: 60,
    autoscalingGroupName: autoScalingGroup.name,
});

const scaleDownPolicy = new aws.autoscaling.Policy("scale-down", {
    scalingAdjustment: -1,
    adjustmentType: "ChangeInCapacity",
    cooldown: 60,
    autoscalingGroupName: autoScalingGroup.name,
});

// Create CloudWatch alarms for CPU utilization.
const cpuHighAlarm = new aws.cloudwatch.MetricAlarm("cpuHighAlarm", {
    comparisonOperator: "GreaterThanOrEqualToThreshold", // Add this line
    evaluationPeriods: 1, // You may need to specify other required properties
    metricName: "CPUUtilization",
    namespace: "AWS/EC2",
    period: 60,
    statistic: "Average",
    threshold: 5, // Set your desired threshold value
    alarmActions: [scaleUpPolicy.arn],
    dimensions: {
        AutoScalingGroupName: autoScalingGroup.name,
    },
});

const cpuLowAlarm = new aws.cloudwatch.MetricAlarm("cpuLowAlarm", {
    comparisonOperator: "LessThanOrEqualToThreshold", // Add this line
    evaluationPeriods: 1, // You may need to specify other required properties
    metricName: "CPUUtilization",
    namespace: "AWS/EC2",
    period: 60,
    statistic: "Average",
    threshold: 3, // Set your desired threshold value
    alarmActions: [scaleDownPolicy.arn],
    dimensions: {
        AutoScalingGroupName: autoScalingGroup.name,
    }
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

   // Retrieve the hosted zone by domain name
const hostedZone = pulumi.output(aws.route53.getZone({ name: "demo.awswebapp.tech" }));

// Define the A record using the ALB's DNS name and Zone ID
const aRecord = new aws.route53.Record("appARecord", {
    zoneId: hostedZone.id,
    name: "demo.awswebapp.tech", // The domain name for the record
    type: "A", // Type A record
    aliases: [{
        name: alb.dnsName, // The DNS name of your ALB
        zoneId: alb.zoneId, // The hosted zone ID of your ALB
        evaluateTargetHealth: true,
    }],
});

// Create a Google Cloud Storage bucket
const bucket = new gcp.storage.Bucket("my-bucket", {
    location: "US",
});

// Create a Google Service Account
const serviceAccount = new gcp.serviceaccount.Account("my-service-account-uq-ar", {
    accountId: "my-service-account-uq-ar",
    displayName: "My Service Account-uq-ar",
  });

// Create a Google Service Account Key
const serviceAccountKey = new gcp.serviceaccount.Key("my-service-account-key", {
    serviceAccountId: serviceAccount.name, // This refers to the name (not accountId) of the service account
});


// IAM role for Lambda Function
const lambdaRole = new aws.iam.Role("lambdaRole", {
    assumeRolePolicy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
            {
                Action: "sts:AssumeRole",
                Effect: "Allow",
                Principal: {
                    Service: "lambda.amazonaws.com",
                },
            },
        ],
    }),
    tags: applyTags({ "Resource": "LambdaRole" }),
});

// IAM policy for Lambda Function
const lambdaPolicy = new aws.iam.Policy("lambdaPolicy", {
    policy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
            {
                Action: ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"],
                Resource: "arn:aws:logs:*:*:*",
                Effect: "Allow",
            },
            // Additional permissions can be added here
        ],
    }),
});

// Attach the policy to the role
new aws.iam.RolePolicyAttachment("lambdaPolicyAttachment", {
    role: lambdaRole.name,
    policyArn: lambdaPolicy.arn,
});

// Create a Lambda function
const lambdaFunction = new aws.lambda.Function("myLambdaFunction", {
    runtime: "nodejs14.x",
    role: lambdaRole.arn,
    handler: "index.handler", // The function within your code that will be called
    code: new pulumi.asset.FileArchive("/Users/anujakale/Desktop/lambda-function.zip"), // Local zip file path
    environment: {
        variables: {
            GCS_BUCKET_NAME: bucket.name,
            GCS_SERVICE_ACCOUNT_KEY: serviceAccountKey.privateKey,
            // Additional environment variables
        },
    },
});



// Export outputs
exports.bucketName = bucket.name;
exports.serviceAccountEmail = serviceAccount.email;
exports.serviceAccountKey = serviceAccountKey.privateKey;
exports.lambdaFunctionName = lambdaFunction.name;
exports.loadBalancerDnsName = alb.dnsName;



// Export the DNS name of the load balancer
exports.loadBalancerDnsName = alb.dnsName;});