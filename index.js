const aws = require("@pulumi/aws");
const pulumi = require("@pulumi/pulumi");

// Create a new IAM role for the EC2 instance
const role = new aws.iam.Role("my-instance-role", {
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
});

// Attach the AWS managed CloudWatchAgentServerPolicy to the role
const policyAttachment = new aws.iam.RolePolicyAttachment("my-role-policy-attachment", {
  role: role,
  policyArn: "arn:aws:iam::aws:policy/CloudWatchAgentServerPolicy", // This is the ARN for the AWS managed policy
});

// Create an IAM instance profile for the EC2 instance
const instanceProfile = new aws.iam.InstanceProfile("my-instance-profile", {
  role: role,
});

// Security group to allow HTTP ingress on port 8080
const securityGroup = new aws.ec2.SecurityGroup("http-sg", {
  ingress: [
    {
      protocol: "tcp",
      fromPort: 8080,
      toPort: 8080,
      cidrBlocks: ["0.0.0.0/0"],
    },
  ],
  egress: [
    {
      protocol: "-1",
      fromPort: 0,
      toPort: 0,
      cidrBlocks: ["0.0.0.0/0"],
    },
  ],
});

// Create an EC2 instance
const instance = new aws.ec2.Instance("web-server-instance", {
  ami: "ami-09dfefe886908288e", // Replace with your AMI ID
  instanceType: "t2.micro",
  securityGroups: [securityGroup.name],
  iamInstanceProfile: instanceProfile.name,
  userData: `#!/bin/bash
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

// Get the hosted zone by the domain name, make sure to handle the promise correctly
const zone = pulumi.output(aws.route53.getZone({ name: "demo.awswebapp.tech" }));

// Create or update a new A record to point to the EC2 instance
const record = new aws.route53.Record("app-a-record", {
  zoneId: zone.id,
  name: "demo.awswebapp.tech",
  type: "A",
  ttl: 60,
  records: [instance.publicIp],
});

// Export the DNS name of the EC2 instance
exports.instanceDnsName = instance.publicDns;

