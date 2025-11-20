const Zigbee2mqttHelper = require('../resources/Zigbee2mqttHelper.js');

module.exports = function(RED) {
    class Zigbee2mqttNodeOut {
        constructor(config) {
            RED.nodes.createNode(this, config);


            let node = this;            // Guarda a referência do nó para usar dentro de callbacks (✅ útil).
            node.config = config;       // Guarda a configuração do nó. Isto já era feito na versão original.             
            node.cleanTimer = null;     // Timer para limpar o status. No out.js, este é realmente usado (ex: depois do publish) ✅
            
            node.status({});            // Inicializa o status do nó (limpa). ✅ útil e seguro.
            node.server = RED.nodes.getNode(node.config.server);    //Obtém o nó do servidor Zigbee2MQTT. Igual ao original ✅
            
            if (!node.server) {
                node.status({
                    fill: "red",
                    shape: "dot",
                    text: "node-red-contrib-zigbee2mqtt/out:status.no_server"
                });
                return;
            }
            
// ─── Listeners MQTT ─────────────────────────────
            node.listener_onMQTTMessage = data => node.onMQTTMessage(data);
            node.server.on('onMQTTMessage', node.listener_onMQTTMessage);

            node.listener_onMQTTAvailability = data => node.onMQTTAvailability(data);
            node.server.on('onMQTTAvailability', node.listener_onMQTTAvailability);

            node.listener_onMQTTBridgeState = data => node.onMQTTBridgeState(data);
            node.server.on('onMQTTBridgeState', node.listener_onMQTTBridgeState);

            node.listener_onConnectError = () => node.onConnectError();
            node.server.on('onConnectError', node.listener_onConnectError);

            node.on('close', () => node.onClose());

            // ─── Input handler ──────────────────────────────
            node.on('input', message => {
                clearTimeout(node.cleanTimer);

                let key = node.config.device_id;
                if ((!key || key === 'msg.topic') && message.topic) key = message.topic;

                let device = node.server.getDeviceOrGroupByKey(key);
                if (!device) {
                    node.status({ fill: "red", shape: "dot", text: "no_device" });
                    return;
                }

                let payload = node.getPayload(message, device);
                let command = node.getCommand(message, payload, device);
                let options = node.getOptions(message);

                if (payload === null) return;

                let toSend = (typeof payload === "object") ? payload : { [command]: payload };

                // Aplica options adicionais
                if (Object.keys(options).length) node.server.setDeviceOptions(device.friendly_name, options);

                // Publica MQTT
                node.server.mqtt.publish(
                    node.server.getTopic(`/${device.friendly_name}/set`),
                    JSON.stringify(toSend),
                    { qos: parseInt(node.server.config.mqtt_qos || 0) },
                    err => { if (err) node.error(err); }
                );

                // Atualiza status visual
                let fill = node.server.getDeviceAvailabilityColor(node.server.getTopic(`/${device.friendly_name}`));
                let text = (typeof payload === "object") ? 'json' : `${command}: ${payload}`;
                node.setSuccessfulStatus({ fill, shape: "dot", text });

                // ─── Atualiza dropdown dinamicamente ─────────────
                if (device.current_values) {
                    node.server.nodeSend(node, {
                        changed: {
                            item: {
                                id: device.ieee_address || device.friendly_name,
                                values: device.current_values
                            }
                        }
                    });
                }
            });
        }

        // ─── Funções auxiliares ─────────────────────────────
        getPayload(message, device) {
            let node = this;
            let payload;
            switch (node.config.payloadType) {
                case 'nothing': case '': case null: payload = null; break;
                case 'flow': case 'global':
                    RED.util.evaluateNodeProperty(node.config.payload, node.config.payloadType, node, message, (err, result) => {
                        payload = err ? null : result;
                    });
                    break;
                case 'z2m_payload': payload = node.config.payload; break;
                case 'num': payload = parseInt(node.config.payload); break;
                case 'str': payload = node.config.payload; break;
                case 'msg': default: payload = message[node.config.payload]; break;
            }
            return payload;
        }

        getCommand(message, payload, device) {
            let node = this;
            let command = node.config.command;

            if (node.config.commandType === 'msg') command = message[node.config.command];
            else if (node.config.commandType === 'z2m_cmd') {
                switch (command) {
                    case 'state':
                        if (payload === 'toggle' && device.current_values && 'position' in device.current_values)
                            payload = device.current_values.position > 0 ? 'close' : 'open';
                        break;
                    case 'brightness': payload = parseInt(payload); break;
                    case 'position': payload = parseInt(payload); break;
                    case 'lock':
                        if (payload === 'toggle') payload = device.current_values.lock_state === 'locked' ? 'unlock' : 'lock';
                        break;
                    case 'color': payload = { color: payload }; break;
                    default: break;
                }
            }
            return command;
        }

        getOptions(message) {
            let node = this;
            let optionsToSend = {};
            switch (node.config.optionsType) {
                case 'msg':
                    if (node.config.optionsValue in message && typeof message[node.config.optionsValue] === 'object')
                        optionsToSend = message[node.config.optionsValue];
                    break;
                case 'json':
                    if (Zigbee2mqttHelper.isJson(node.config.optionsValue))
                        optionsToSend = JSON.parse(node.config.optionsValue);
                    break;
                default:
                    if (node.config.optionsType) optionsToSend[node.config.optionsType] = node.config.optionsValue;
            }
            return optionsToSend;
        }

        // ─── Listeners MQTT ─────────────────────────────
        onMQTTMessage(data) {
            let node = this;
            if (!data.item) return;

            if (node.config.enableMultiple) {
                if (("ieee_address" in data.item && node.config.device_id.includes(data.item.ieee_address))
                    || ("id" in data.item && node.config.device_id.includes(data.item.id))) {
                    node.server.nodeSend(node, { changed: data });
                }
            } else {
                if (("ieee_address" in data.item && data.item.ieee_address === node.config.device_id)
                    || ("id" in data.item && parseInt(data.item.id) === parseInt(node.config.device_id))) {
                    node.server.nodeSend(node, { filter: node.config.filterChanges });
                }
            }
        }

        onMQTTAvailability(data) { /* opcional, se quiser feedback */ }

        onMQTTBridgeState(data) {
            if (data && data.payload) {
                if (this.last_successful_status && Object.keys(this.last_successful_status).length) {
                    this.status(this.last_successful_status);
                } else {
                    this.status({ fill: "green", shape: "dot", text: "connected" });
                }
            } else {
                this.onConnectError();
            }
        }

        onConnectError() {
            this.status({ fill: "red", shape: "dot", text: "node-red-contrib-zigbee2mqtt/out:status.no_connection" });
        }

        onClose() {
            let node = this;
            if (node.listener_onMQTTAvailability) node.server.removeListener("onMQTTAvailability", node.listener_onMQTTAvailability);
            if (node.listener_onConnectError) node.server.removeListener("onConnectError", node.listener_onConnectError);
            if (node.listener_onMQTTMessage) node.server.removeListener("onMQTTMessage", node.listener_onMQTTMessage);
            if (node.listener_onMQTTBridgeState) node.server.removeListener("onMQTTBridgeState", node.listener_onMQTTBridgeState);
        }

        setSuccessfulStatus(obj) {
            this.status(obj);
            this.last_successful_status = obj;
        }
    }

    RED.nodes.registerType('zigbee2mqtt-out', Zigbee2mqttNodeOut);
};


