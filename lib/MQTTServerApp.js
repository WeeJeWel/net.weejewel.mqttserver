'use strict';

const fs = require('fs');
const path = require('path');
const net = require('net');
const tls = require('tls');

const Homey = require('homey');
const { HomeyAPI } = require('homey-api');
const Aedes = require('aedes');
const AedesClient = require('aedes/lib/client');
const getPort = require('get-port');

const HomieUtil = require('./HomieUtil');

const PORT_MQTT = 1883;
const PORT_MQTTS = 8883;

module.exports = class MQTTServerApp extends Homey.App {

  topics = new Set();

  async onInit() {
    // Ensure Users Exist
    await this.getUsers();

    // Get Available Ports
    this.portMqtt = await getPort({ port: getPort.makeRange(PORT_MQTT, PORT_MQTT + 100) });
    this.portMqtts = await getPort({ port: getPort.makeRange(PORT_MQTTS, PORT_MQTTS + 100) });

    // Start Aedes
    this.aedes = Aedes();
    this.aedes.on('client', client => {
      this.log(`Client Connected: ${client.id}`);
    });
    this.aedes.on('publish', (packet, client) => {
      this.onPublish(packet, client);
    });
    this.aedes.authenticate = (client, username, password, callback) => {
      Promise.resolve().then(async () => {
        const users = await this.getUsers();
        const user = Object.values(users).find(user => user.username === username);
        if (!user) return callback(new Error('User Not Found'), false);

        return callback(null, user.password === String(password));
      }).catch(err => callback(err, null));
    };

    // Start the MQTT Server
    await new Promise((resolve, reject) => {
      this.server = net.createServer(this.aedes.handle);
      this.server.listen(this.portMqtt, err => {
        if (err) return reject(err);
        return resolve();
      });
    })
      .then(() => {
        this.log(`Listening on mqtt://0.0.0.0:${this.portMqtt}`);
      })
      .catch(err => {
        this.error(`Error Starting MQTT Server: ${err.message}`);
        throw err;
      });

    // Start the MQTTS Server
    await new Promise((resolve, reject) => {
      this.serverSecure = tls.createServer({
        key: fs.readFileSync(path.join(__dirname, '..', 'assets', 'certificates', 'private-key.pem')),
        cert: fs.readFileSync(path.join(__dirname, '..', 'assets', 'certificates', 'public-cert.pem')),
      }, this.aedes.handle);
      this.serverSecure.listen(this.portMqtts, err => {
        if (err) return reject(err);
        return resolve();
      });
    })
      .then(() => {
        this.log(`Listening on mqtts://0.0.0.0:${this.portMqtts}`);
      })
      .catch(err => {
        this.error(`Error Starting MQTTS Server: ${err.message}`);
        throw err;
      });

    // Initialize Homey Web API
    this.api = await HomeyAPI.createAppAPI({
      homey: this.homey,
    });

    // Subscribe to ManagerDevices
    await this.api.devices.connect();
    this.api.devices
      .on('device.create', device => {
        this.log(`Device ${device.id} Created`);
        this.initDevice(device);
      })
      .on('device.update', device => {
        this.log(`Device ${device.id} Updated`);
        this.publishDevice(device);

        // TODO: Capabilities added/removed
      })
      .on('device.delete', device => {
        this.log(`Device ${device.id} Deleted`);
        this.uninitDevice(device);
      });

    // Publish Existing Devices
    const devices = await this.api.devices.getDevices();
    for (const device of Object.values(devices)) {
      this.initDevice(device);
    }

    // Initialize Flow
    await this.homey.flow
      .getTriggerCard('specific-topic-published')
      .registerRunListener(async (tokens, state) => {
        return tokens.topic === state.topic;
      });
  }

  initDevice(device) {
    // Subscribe to Device Capabilities
    device.connect()
      .then(() => {
        device.on('capability', ({ capabilityId, value }) => {
          const capabilityObj = device.capabilitiesObj?.[capabilityId];
          if (!capabilityObj) return;

          this.publishDeviceCapability(device, capabilityId, capabilityObj, value);
        });
      })
      .catch(err => this.error(`Error Connecting Device ${device.id}: ${err.message}`));

    // Publish Existing Device Capabilities
    for (const [capabilityId, capabilityObj] of Object.entries(device.capabilitiesObj ?? {})) {
      this.publishDeviceCapability(device, capabilityId, capabilityObj, capabilityObj.value);
    }

    // Publish Device
    this.publishDevice(device);
  }

  uninitDevice(device) {
    this.unpublishDevice(device);
  }

  publish(topic, payload) {
    this.topics.add(topic);
    this.aedes.publish({
      topic,
      payload,
      qos: 1,
      retain: true,
    });
  }

  unpublish(topic) {
    this.topics.delete(topic);
    this.aedes.publish({
      topic,
      payload: '',
      qos: 1,
      retain: true,
    });
  }

  publishDevice(device) {
    this.publish(`homey/devices/${device.id}/id`, JSON.stringify(device.id));
    this.publish(`homey/devices/${device.id}/name`, JSON.stringify(device.name));

    this.publish(`homie/5/${device.id}/$homie`, '3.0');
    this.publish(`homie/5/${device.id}/$name`, String(device.name));
    this.publish(`homie/5/${device.id}/$state`, device.available ? 'ready' : 'disconnected');
  }

  publishDeviceCapability(device, capabilityId, capabilityObj, value) {
    this.unpublish(`homey/devices/${device.id}/capabilities/${capabilityId}`);
    this.publish(`homey/devices/${device.id}/capabilities/${capabilityId}/value`, JSON.stringify(value));
    this.publish(`homey/devices/${device.id}/capabilities/${capabilityId}/name`, JSON.stringify(capabilityObj.title));
    this.publish(`homey/devices/${device.id}/capabilities/${capabilityId}/type`, JSON.stringify(capabilityObj.type));
    this.publish(`homey/devices/${device.id}/capabilities/${capabilityId}/units`, JSON.stringify(capabilityObj.units));
    this.publish(`homey/devices/${device.id}/capabilities/${capabilityId}/getable`, JSON.stringify(capabilityObj.getable));
    this.publish(`homey/devices/${device.id}/capabilities/${capabilityId}/setable`, JSON.stringify(capabilityObj.setable));

    this.publish(`homie/5/${device.id}/main/${capabilityId}`, String(value));
    this.publish(`homie/5/${device.id}/main/${capabilityId}/$name`, String(capabilityObj.title));
    this.publish(`homie/5/${device.id}/main/${capabilityId}/$unit`, String(capabilityObj.units ?? ''));
    this.publish(`homie/5/${device.id}/main/${capabilityId}/$datatype`, HomieUtil.homeyTypeToHomieDatatype(capabilityObj.type));
    this.publish(`homie/5/${device.id}/main/${capabilityId}/$settable`, String(true));
  }

  unpublishDevice(device) {
    for (const topic of this.topics) {
      if (topic.startsWith(`homey/devices/${device.id}/`)) {
        this.unpublish(topic);
      }
    }
  }

  onPublish(packet, client) {
    if (!(client instanceof AedesClient)) return;

    // Accept Capability Set for `homey`
    Promise.resolve().then(async () => {
      const regex = new RegExp('homey/devices/(?<deviceId>[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/capabilities/(?<capabilityId>[A-Za-z0-9._-]+)');
      const parsed = regex.exec(packet.topic);
      if (!parsed) return;

      const { deviceId, capabilityId } = parsed.groups;
      if (!deviceId) return;
      if (!capabilityId) return;

      const value = JSON.parse(packet.payload);
      await this.api.devices.setCapabilityValue({
        deviceId,
        capabilityId,
        value,
      });
    }).catch(err => this.error(`Error Parsing Published Packet: ${err.message}`));

    // Accept Capability Set for `homie`
    Promise.resolve().then(async () => {
      const regex = new RegExp('homie/5/(?<deviceId>[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/main/(?<capabilityId>[A-Za-z0-9._-]+)/set');
      const parsed = regex.exec(packet.topic);
      if (!parsed) return;

      const { deviceId, capabilityId } = parsed.groups;
      if (!deviceId) return;
      if (!capabilityId) return;

      const value = JSON.parse(packet.payload);
      await this.api.devices.setCapabilityValue({
        deviceId,
        capabilityId,
        value,
      });
    }).catch(err => this.error(`Error Parsing Published Packet: ${err.message}`));

    // Trigger Flow
    Promise.resolve().then(async () => {
      await this.homey.flow
        .getTriggerCard('any-topic-published')
        .trigger({
          value: String(packet.payload),
          topic: String(packet.topic),
        });

      await this.homey.flow
        .getTriggerCard('specific-topic-published')
        .trigger({
          value: String(packet.payload),
          topic: String(packet.topic),
        }, {
          topic: packet.topic,
        });
    }).catch(err => this.error(`Error Triggering Flow: ${err.message}`));
  }

  async getUsers() {
    let users = await this.homey.settings.get('users');
    if (!users) {
      await this.homey.settings.set('users', {
        // Model:
        // [userId]: {
        //   username: String,
        //   password: String,
        // },
      });

      users = await this.homey.settings.get('users');
    }

    return users;
  }

  async getLocalIp() {
    const localAddress = await this.homey.cloud.getLocalAddress();
    const [localIp] = localAddress.split(':');
    return localIp;
  }

  async getStatus() {
    return {
      localIp: await this.getLocalIp(),
      portMqtt: this.portMqtt,
      portMqtts: this.portMqtts,
    };
  }

}