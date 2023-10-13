// "use strict";
// const pulumi = require("@pulumi/pulumi");
// const aws = require("@pulumi/aws");
// const awsx = require("@pulumi/awsx");

// // Create an AWS resource (S3 Bucket)
// const bucket = new aws.s3.Bucket("my-bucket");

// // Export the name of the bucket
// exports.bucketName = bucket.id;


"use strict";
const pulumi = require("@pulumi/pulumi");
const aws = require("@pulumi/aws");

// Create a VPC
const vpc = new aws.ec2.Vpc("myVPC", {
    cidrBlock: "10.0.0.0/16",
});

// Create an Internet Gateway
const ig = new aws.ec2.InternetGateway("myIG", {
    vpcId: vpc.id,
});

// Create 3 Public Subnets
const publicSubnets = [];
for (let i = 0; i < 3; i++) {
    publicSubnets.push(new aws.ec2.Subnet(`publicSubnet-${i}`, {
        cidrBlock: `10.0.${i}.0/24`,
        vpcId: vpc.id,
        mapPublicIpOnLaunch: true,
        availabilityZone: `us-east-1${String.fromCharCode(97 + i)}`, // us-east-1a, us-east-1b, us-east-1c
    }));
}

// Create 3 Private Subnets
const privateSubnets = [];
for (let i = 3; i < 6; i++) {
    privateSubnets.push(new aws.ec2.Subnet(`privateSubnet-${i-3}`, {
        cidrBlock: `10.0.${i}.0/24`,
        vpcId: vpc.id,
        availabilityZone: `us-east-1${String.fromCharCode(94 + i)}`, // us-east-1a, us-east-1b, us-east-1c
    }));
}

// Create Public Route Table
const publicRouteTable = new aws.ec2.RouteTable("publicRouteTable", {
    vpcId: vpc.id,
});

// Associate Public Subnets with Public Route Table
publicSubnets.forEach((subnet, index) => {
    new aws.ec2.RouteTableAssociation(`publicRTA-${index}`, {
        subnetId: subnet.id,
        routeTableId: publicRouteTable.id,
    });
});

// Create Private Route Table
const privateRouteTable = new aws.ec2.RouteTable("privateRouteTable", {
    vpcId: vpc.id,
});

// Associate Private Subnets with Private Route Table
privateSubnets.forEach((subnet, index) => {
    new aws.ec2.RouteTableAssociation(`privateRTA-${index}`, {
        subnetId: subnet.id,
        routeTableId: privateRouteTable.id,
    });
});

// Create a public route
const publicRoute = new aws.ec2.Route("publicRoute", {
    routeTableId: publicRouteTable.id,
    destinationCidrBlock: "0.0.0.0/0",
    gatewayId: ig.id,
});

// Export the VPC ID and the public and private subnet IDs
exports.vpcId = vpc.id;
exports.publicSubnetIds = publicSubnets.map(subnet => subnet.id);
exports.privateSubnetIds = privateSubnets.map(subnet => subnet.id);
