This app creates a MQTT Server (also called Broker), and publishes Homey Pro's devices' state to it.

USAGE
First, create a new user with a username & password in the app's Advanced Settings.

Then, download any MQTT Client and connect to Homey Pro's IP address on your LAN. All topics should be visible automatically.

To set the status of a device, publish a JSON-strigified value to `homey/devices/<device-id>/capabilities/<capability-id>`. For example, publish `true` to `homey/devices/abc...efg/capabilities/onoff` to turn on a device.

NOTES
The server also supports the 'homie' convention (see https://homieiot.github.io) for compatibility with 3rd party MQTT clients.