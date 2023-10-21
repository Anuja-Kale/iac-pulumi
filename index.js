const pulumi = require("@pulumi/pulumi");
const aws = require("@pulumi/aws");

// Create a pulumi.Config instance to access configuration settings
const config = new pulumi.Config();

// Use configuration settings or provide defaults
const vpcCidr = config.require("vpcCidr");
const cidr = config.require("cidr");
const cidrEnd = config.require("cidrEnd");
const vpcName = config.require("vpcName");
const internetGatewayName = config.require("internetGatewayName");
const publicRouteTableName = config.require("publicRouteTableName");
const privateRouteTableName = config.require("privateRouteTableName");
const publicRouteCidrBlock = config.require("publicRouteCidrBlock");
const subnetIds = [];

const vpc = new aws.ec2.Vpc(vpcName, {
  cidrBlock: vpcCidr,
});

const igw = new aws.ec2.InternetGateway(internetGatewayName, {
  vpcId: vpc.id,
});

const publicRouteTable = new aws.ec2.RouteTable(publicRouteTableName, {
  vpcId: vpc.id,
});

const publicRoute = new aws.ec2.Route("publicRoute", {   routeTableId: publicRouteTable.id,   destinationCidrBlock: publicRouteCidrBlock,   gatewayId: igw.id, });

const privateRouteTable = new aws.ec2.RouteTable(privateRouteTableName, {
  vpcId: vpc.id,
});

const azs = aws.getAvailabilityZones();

const calculateCidrBlock = (index, subnetType) => {
  const subnetNumber = subnetType === "public" ? index * 2 : index * 2 + 1;
  return `10.0.${subnetNumber}.0/24`; // Change the VPC CIDR range accordingly
};

azs.then((az) => {
  const maxSubnets = 6;
  let subnetCount = 0;
  az.names.forEach((zoneName, azIndex) => {
    if (subnetCount >= maxSubnets) return;
    let subnetsToCreate;
    // Determine the number of subnets to create based on the AZ count and index
    if (az.names.length <= 2) {
      subnetsToCreate = azIndex === 0 ? 2 : 2;
    } else {
      subnetsToCreate = 2;
    }
    for (let i = 0; i < subnetsToCreate; i++) {
      if (subnetCount >= maxSubnets) break;
      const subnetType = i % 2 === 0 ? "public" : "private";
      const routeTable =
        subnetType === "public" ? publicRouteTable : privateRouteTable;
      const subnetName = `${subnetType}-subnet-${subnetCount}`;
      const subnet = new aws.ec2.Subnet(subnetName, {
        vpcId: vpc.id,
        availabilityZone: zoneName,
        cidrBlock: calculateCidrBlock(subnetCount, subnetType),
        mapPublicIpOnLaunch: subnetType === "public",
      });
      subnetIds.push(subnet.id);
      new aws.ec2.RouteTableAssociation(`${subnetType}-rta-${subnetCount}`, {
        subnetId: subnet.id,
        routeTableId: routeTable.id,
      });
      subnetCount++;
    }
  });


  const webAppSecurityGroup = new aws.ec2.SecurityGroup("webapp-sg", {
    vpcId: vpc.id,
    ingress: [
      {
        fromPort: 22,
        toPort: 22,
        protocol: "tcp",
        cidrBlocks: ["0.0.0.0/0"], // Allow SSH from anywhere
      },
      {
        fromPort: 80,
        toPort: 80,
        protocol: "tcp",
        cidrBlocks: ["0.0.0.0/0"], // Allow HTTP from anywhere
      },
      {
        fromPort: 443,
        toPort: 443,
        protocol: "tcp",
        cidrBlocks: ["0.0.0.0/0"], // Allow HTTPS from anywhere
      },
      {
        fromPort: 8080, // Change to your application's port
        toPort: 8080, // Change to your application's port
        protocol: "tcp",
        cidrBlocks: ["0.0.0.0/0"], // Allow your application traffic from anywhere
      },
    ],
  });

  // Replace this with your custom AMI ID
  const customAmiId = "ami-0566e01388bfcdce5"; // Replace with your custom AMI ID

  // Create an EC2 instance
  const ec2Instance = new aws.ec2.Instance("webapp-instance", {
    ami: customAmiId, // Use your custom AMI ID here
    instanceType: "t2.micro", // Change to your desired instance type
    subnetId: subnetIds[3], // Use the first captured subnet ID
    vpcSecurityGroupIds: [webAppSecurityGroup.id],
    rootBlockDevice: {
      volumeSize: 25,
      volumeType: "gp2",
      deleteOnTermination: true,
    },
    ebsBlockDevices: [
      {
        deviceName: "/dev/xvdf",
        volumeSize: 25,
        volumeType: "gp2",
        deleteOnTermination: true,
      },
    ],
    keyName: "key-pair",
    tags: {
      Name: "WebAppInstance",
    },
  }
 );

});
