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

    const ec2Instance = new aws.ec2.Instance("csye6225-ec2", {
        ami: "ami-0a0ca34e91ebf89a0",
        instanceType: "t2.micro",
        keyName: "ec2-key",
        vpcSecurityGroupIds: [appSecurityGroup.id],
        subnetId: publicSubnets[0].id,
        associatePublicIpAddress: true,
        tags: applyTags({ "Resource": "EC2Instance" }),
        userData: pulumi.interpolate`
        #!/bin/bash
        echo "NODE_ENV=envProd" >> /etc/environment
        endpoint="${dbInstance.endpoint}"
        echo "DB_HOST=\${endpoint%:*}" >> /etc/environment
        echo DB_USERNAME=csye6225 >> /etc/environment
        echo DB_PASSWORD=root1234 >> /etc/environment
        echo DB_DATABASE=csye6225 >> /etc/environment
        sudo systemctl start rds
        `.apply(s => s.trim()),
    });

}).catch(error => {
    console.error("Error fetching availability zones:", error);
});
