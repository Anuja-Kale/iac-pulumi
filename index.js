const aws = require("@pulumi/aws");
const pulumi = require("@pulumi/pulumi");

// Create a new IAM role for the EC2 instance
const role = new aws.iam.Role("my-instance-role", {
  assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({
    Service: "ec2.amazonaws.com",
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

// Security group to allow HTTP ingress
const securityGroup = new aws.ec2.SecurityGroup("http-sg", {
  ingress: [
    {
      protocol: "tcp",
      fromPort: 8080,
      toPort: 8080,
      cidrBlocks: ["0.0.0.0/0"],
    }
  ],
  egress: [
    {
      protocol: "-1",
      fromPort: 0,
      toPort: 0,
      cidrBlocks: ["0.0.0.0/0"],
    }
  ]
});

// Create an EC2 instance
const instance = new aws.ec2.Instance("web-server-instance", {
  ami: "ami-0c55b159cbfafe1f0", // Replace with your AMI ID
  instanceType: "t2.micro",
  securityGroups: [securityGroup.name],
  iamInstanceProfile: instanceProfile.name,
  userData: `#!/bin/bash
echo "Installing CloudWatch Agent..."
# Your commands to install CloudWatch Agent here
# For example:
# wget https://s3.amazonaws.com/amazoncloudwatch-agent/ubuntu/amd64/latest/amazon-cloudwatch-agent.deb
# dpkg -i -E ./amazon-cloudwatch-agent.deb
# Configure the CloudWatch Agent
# (Add commands to configure the agent here)
# Start the CloudWatch Agent
# /opt/aws/amazon-cloudwatch-agent/bin/start-amazon-cloudwatch-agent
`
});

// Get the hosted zone by the domain name
const zone = aws.route53.getZone({ name: "awswebapp.tech" });

// Create a new A record to point to the EC2 instance
const record = new aws.route53.Record("app-a-record", {
  zoneId: zone.then(z => z.id),
  name: "awswebapp.tech",
  type: "A",
  ttl: 300,
  records: [instance.publicIp],
});

// Export the DNS name of the EC2 instance
exports.instanceDnsName = instance.publicDns;
