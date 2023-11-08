const pulumi = require("@pulumi/pulumi");
const aws = require("@pulumi/aws");

// Retrieve configuration and secrets.
const config = new pulumi.Config();
//const dbPassword = config.requireSecret("dbPassword");

function applyTags(additionalTags = {}) {
    let tags = { "Name": pulumi.getProject(), "Type": pulumi.getStack() };
    return { ...tags, ...additionalTags };
}

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

    const appSecurityGroup = new aws.ec2.SecurityGroup("app-sg", {
        vpcId: vpc.id,
        description: "Allow inbound HTTP, HTTPS, SSH, and custom traffic",
        ingress: [
            { protocol: "tcp", fromPort: 80, toPort: 80, cidrBlocks: ["0.0.0.0/0"] },
            { protocol: "tcp", fromPort: 443, toPort: 443, cidrBlocks: ["0.0.0.0/0"] },
            { protocol: "tcp", fromPort: 8080, toPort: 8080, cidrBlocks: ["0.0.0.0/0"] },
            { protocol: "tcp", fromPort: 22, toPort: 22, cidrBlocks: ["0.0.0.0/0"] }
        ],
        egress: [{ protocol: "-1", fromPort: 0, toPort: 0, cidrBlocks: ["0.0.0.0/0"] }],
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

    // Create IAM role and instance profile for EC2 instances
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

  // Attach the AWS managed CloudWatchAgentServerPolicy to the role
const policyAttachment = new aws.iam.RolePolicyAttachment("my-role-policy-attachment", {
  role: ec2Role, // Use ec2Role variable instead of undefined 'role'
  policyArn: "arn:aws:iam::aws:policy/CloudWatchAgentServerPolicy",
});


// Create an IAM instance profile for the EC2 instance
const instanceProfile = new aws.iam.InstanceProfile("my-instance-profile", {
  role: ec2Role, // Use ec2Role variable instead of undefined 'role'
  });




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

    const ec2Instance2 = new aws.ec2.Instance("app-instance", {
      instanceType: "t2.micro",
      ami: "ami-0b389a45c8ba408eb", // Please replace with a valid AMI ID
      subnetId: publicSubnets[0].id,
      securityGroups: [appSecurityGroup.name],
      associatePublicIpAddress: true,
      iamInstanceProfile: instanceProfile.name, // Use instanceProfile variable
      userData: `#!/bin/bash
      echo "NODE_ENV=production" >> /etc/environment
      endpoint="${dbInstance.endpoint}"
      echo "DB_HOST=\${endpoint%:*}" >> /etc/environment
      echo DB_USERNAME=csye6225 >> /etc/environment
      echo DB_PASSWORD=root1234 >> /etc/environment
      echo DB_DATABASE=csye6225 >> /etc/environment
      
      # Install and configure the CloudWatch Agent
      sudo yum install -y amazon-cloudwatch-agent
      # Assuming you have a configuration file on S3 or passed through the user data
      # aws s3 cp s3://mybucket/my-cloudwatch-agent-config.json /etc/cwagent-config.json
      # Apply the configuration
      sudo /opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl -a fetch-config -m ec2 -c file:/etc/cwagent-config.json -s
      # Start the CloudWatch Agent
      sudo systemctl enable amazon-cloudwatch-agent
      sudo systemctl start amazon-cloudwatch-agent
      `,
      
      tags: {
          "Name": "web-server-instance"
      },
  });
  


// Get the hosted zone by the domain name, ensuring to handle the promise correctly
const zone = pulumi.output(aws.route53.getZone({ name: "demo.awswebapp.tech" }));

// Create or update a new A record to point to the EC2 instance
const record = new aws.route53.Record("app-a-record", {
  zoneId: zone.id,
  name: "demo.awswebapp.tech",
  type: "A",
  ttl: 60,
  records: [ec2Instance2.publicIp], // Use ec2Instance2 instead of instance
});


   // Outputs
exports.publicIpAddress = ec2Instance2.publicIp;
exports.dbAddress = dbInstance.address;
exports.instanceDnsName = ec2Instance2.publicDns;


});
