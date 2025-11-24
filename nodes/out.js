const Zigbee2mqttHelper = require('../resources/Zigbee2mqttHelper.js');

module.exports = function(RED) {
    class Zigbee2mqttNodeOut {
        constructor(config) {
            RED.nodes.createNode(this, config);

            let node = this;
            node.config = config;
            node.cleanTimer = null;
            node.bridgeOnline = false;
            node.last_successful_status = {};
            
            node.status({});
            node.server = RED.nodes.getNode(node.config.server);
            
            if (!node.server) {
                node.status({
                    fill: "red",
                    shape: "dot",
                    text: "no server"
                });
                return;
            }
            
            // ═══════════════════════════════════════════════════════════
            // 🔍 DEBUG: VERIFICAR ESTADO INICIAL
            // ═══════════════════════════════════════════════════════════
            node.log("🔍 [INIT] Checking initial state...");
            node.log("🔍 [INIT] server.connection: " + (node.server.connection ? "YES" : "NO"));
            node.log("🔍 [INIT] server.mqtt: " + (node.server.mqtt ? "YES" : "NO"));
            
            if (node.server.mqtt) {
                node.log("🔍 [INIT] server.mqtt.connected: " + (node.server.mqtt.connected ? "YES" : "NO"));
            }
            
            // ✅ ASSUMIR ONLINE SE MQTT ESTÁ CONECTADO
            if (node.server.connection && node.server.mqtt && node.server.mqtt.connected) {
                node.bridgeOnline = true;
                node.log("✅ [INIT] Bridge set to ONLINE");
                node.status({
                    fill: "green",
                    shape: "dot",
                    text: "ready"
                });
            } else {
                node.log("❌ [INIT] Bridge set to OFFLINE");
            }
            
            // ═══════════════════════════════════════════════════════════
            // LISTENERS MQTT
            // ═══════════════════════════════════════════════════════════
            node.listener_onMQTTMessage = data => node.onMQTTMessage(data);
            node.server.on('onMQTTMessage', node.listener_onMQTTMessage);

            node.listener_onMQTTAvailability = data => node.onMQTTAvailability(data);
            node.server.on('onMQTTAvailability', node.listener_onMQTTAvailability);

            node.listener_onMQTTBridgeState = data => node.onMQTTBridgeState(data);
            node.server.on('onMQTTBridgeState', node.listener_onMQTTBridgeState);

            node.listener_onConnectError = () => node.onConnectError();
            node.server.on('onConnectError', node.listener_onConnectError);

            node.on('close', () => node.onClose());

            // ═══════════════════════════════════════════════════════════
            // INPUT HANDLER
            // ═══════════════════════════════════════════════════════════
            node.on('input', message => {
                node.log("🔥 [INPUT] Received message");
                
                // ✅ LIMPAR timer anterior
                if (node.cleanTimer) {
                    clearTimeout(node.cleanTimer);
                    node.cleanTimer = null;
                }

                // ✅ VALIDAR SERVIDOR MQTT
                node.log("🔍 [INPUT] Checking MQTT connection...");
                
                if (!node.server || !node.server.mqtt) {
                    node.log("❌ [INPUT] MQTT not available");
                    node.status({
                        fill: "red",
                        shape: "dot",
                        text: "no connection"
                    });
                    node.error("MQTT not connected");
                    return;
                }

                // ✅ VALIDAR CONEXÃO MQTT
                if (!node.server.mqtt.connected) {
                    node.log("❌ [INPUT] MQTT disconnected");
                    node.status({
                        fill: "red",
                        shape: "dot",
                        text: "mqtt disconnected"
                    });
                    node.warn("MQTT client disconnected");
                    return;
                }

                // ❌ REMOVER ESTA VALIDAÇÃO - PERMITE ENVIAR MESMO COM BRIDGE OFFLINE
                // Se o MQTT está conectado, os comandos funcionam!
                
                node.log("✅ [INPUT] All checks passed, proceeding...");

                // ✅ VALIDAR DEVICE/GROUP
                let key = node.config.device_id;
                if ((!key || key === 'msg.topic') && message.topic) key = message.topic;

                let device = node.server.getDeviceOrGroupByKey(key);
                if (!device) {
                    node.status({ 
                        fill: "red", 
                        shape: "dot", 
                        text: "no device" 
                    });
                    node.warn("Device not found: " + key);
                    return;
                }

                // ✅ OBTER PAYLOAD, COMMAND E OPTIONS
                let payload = node.getPayload(message, device);
                let command = node.getCommand(message, payload, device);
                let options = node.getOptions(message);

                if (payload === null) {
                    node.warn("Payload is null, skipping");
                    return;
                }

                // ✅ PREPARAR MENSAGEM
                let toSend = (typeof payload === "object") ? payload : { [command]: payload };

                // ✅ APLICAR OPTIONS
                if (Object.keys(options).length) {
                    node.server.setDeviceOptions(device.friendly_name, options);
                }

                // ✅ STATUS: "Sending..."
                node.status({
                    fill: "blue",
                    shape: "ring",
                    text: "sending..."
                });

                // ═══════════════════════════════════════════════════════════
                // ✅ PUBLISH MQTT
                // ═══════════════════════════════════════════════════════════
                const topic = node.server.getTopic(`/${device.friendly_name}/set`);
                const qos = parseInt(node.server.config.mqtt_qos || 0);
                
                node.log("📤 [PUBLISH] Topic: " + topic);
                node.log("📤 [PUBLISH] Payload: " + JSON.stringify(toSend));
                
                node.server.mqtt.publish(
                    topic,
                    JSON.stringify(toSend),
                    { qos: qos },
                    (publishError) => {
                        if (publishError) {
                            node.log("❌ [PUBLISH] Error: " + publishError.message);
                            node.status({
                                fill: "red",
                                shape: "dot",
                                text: "publish failed"
                            });
                            node.error("MQTT publish error: " + publishError.message);
                            
                            node.cleanTimer = setTimeout(() => {
                                node.status({
                                    fill: "red",
                                    shape: "ring",
                                    text: "failed " + Zigbee2mqttHelper.statusUpdatedAt()
                                });
                                node.cleanTimer = null;
                            }, 5000);
                            
                        } else {
                            node.log("✅ [PUBLISH] Success!");
                            let fill = node.server.getDeviceAvailabilityColor(
                                node.server.getTopic(`/${device.friendly_name}`)
                            );
                            let text = (typeof payload === "object") 
                                ? 'json' 
                                : `${command}: ${payload}`;
                            
                            node.setSuccessfulStatus({ fill, shape: "dot", text });
                            
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
                        }
                    }
                );
            });
        }

        // ═══════════════════════════════════════════════════════════
        // FUNÇÕES AUXILIARES
        // ═══════════════════════════════════════════════════════════
        getPayload(message, device) {
            let node = this;
            let payload;
            
            switch (node.config.payloadType) {
                case 'nothing': 
                case '': 
                case null: 
                    payload = null; 
                    break;
                    
                case 'flow': 
                case 'global':
                    RED.util.evaluateNodeProperty(
                        node.config.payload, 
                        node.config.payloadType, 
                        node, 
                        message, 
                        (err, result) => {
                            payload = err ? null : result;
                        }
                    );
                    break;
                    
                case 'z2m_payload': 
                    if (node.config.payload === '__manual__' && node.config.manualPayloadValue) {
                        payload = node.config.manualPayloadValue;
                    } else {
                        payload = node.config.payload;
                    }
                    break;
                    
                case 'num': 
                    payload = parseInt(node.config.payload); 
                    break;
                    
                case 'str': 
                    payload = node.config.payload; 
                    break;
                    
                case 'msg': 
                default: 
                    payload = message[node.config.payload]; 
                    break;
            }
            
            return payload;
        }

        getCommand(message, payload, device) {
            let node = this;
            let command = node.config.command;

            if (node.config.commandType === 'msg') {
                command = message[node.config.command];
            } 
            else if (node.config.commandType === 'z2m_cmd') {
                switch (command) {
                    case 'state':
                        if (payload === 'toggle' && device.current_values && 'position' in device.current_values) {
                            payload = device.current_values.position > 0 ? 'close' : 'open';
                        }
                        break;
                        
                    case 'brightness': 
                        payload = parseInt(payload); 
                        break;
                        
                    case 'position': 
                        payload = parseInt(payload); 
                        break;
                        
                    case 'lock':
                        if (payload === 'toggle') {
                            payload = device.current_values.lock_state === 'locked' ? 'unlock' : 'lock';
                        }
                        break;
                        
                    case 'color': 
                        payload = { color: payload }; 
                        break;
                        
                    default: 
                        break;
                }
            }
            
            return command;
        }

        getOptions(message) {
            let node = this;
            let optionsToSend = {};
            
            switch (node.config.optionsType) {
                case 'msg':
                    if (node.config.optionsValue in message && 
                        typeof message[node.config.optionsValue] === 'object') {
                        optionsToSend = message[node.config.optionsValue];
                    }
                    break;
                    
                case 'json':
                    if (Zigbee2mqttHelper.isJson(node.config.optionsValue)) {
                        optionsToSend = JSON.parse(node.config.optionsValue);
                    }
                    break;
                    
                default:
                    if (node.config.optionsType) {
                        optionsToSend[node.config.optionsType] = node.config.optionsValue;
                    }
            }
            
            return optionsToSend;
        }

        // ═══════════════════════════════════════════════════════════
        // LISTENERS MQTT
        // ═══════════════════════════════════════════════════════════
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

        onMQTTAvailability(data) { 
            // Opcional
        }

        onMQTTBridgeState(data) {
            let node = this;
            
            node.log("🔔 [BRIDGE STATE] Event received");
            node.log("🔔 [BRIDGE STATE] Data: " + JSON.stringify(data));
            
            if (data && data.payload) {
                node.log("🔔 [BRIDGE STATE] payload.state: " + data.payload.state);
            }
            
            // ✅ ATUALIZAR FLAG DO BRIDGE
            if (data && data.payload && data.payload.state === 'online') {
                node.bridgeOnline = true;
                node.log("✅ [BRIDGE STATE] Bridge is ONLINE");
                
                if (node.last_successful_status && Object.keys(node.last_successful_status).length) {
                    node.status(node.last_successful_status);
                } else {
                    node.status({ 
                        fill: "green", 
                        shape: "dot", 
                        text: "ready" 
                    });
                }
            } else {
                node.bridgeOnline = false;
                node.log("❌ [BRIDGE STATE] Bridge is OFFLINE");
                node.onConnectError();
            }
        }

        onConnectError() {
            let node = this;
            node.log("❌ [CONNECT ERROR] Called");
            node.bridgeOnline = false;
            node.status({ 
                fill: "red", 
                shape: "dot", 
                text: "no connection"
            });
        }

        onClose() {
            let node = this;
            node.log("🔒 [CLOSE] Cleaning up...");
            
            if (node.listener_onMQTTAvailability) {
                node.server.removeListener("onMQTTAvailability", node.listener_onMQTTAvailability);
            }
            if (node.listener_onConnectError) {
                node.server.removeListener("onConnectError", node.listener_onConnectError);
            }
            if (node.listener_onMQTTMessage) {
                node.server.removeListener("onMQTTMessage", node.listener_onMQTTMessage);
            }
            if (node.listener_onMQTTBridgeState) {
                node.server.removeListener("onMQTTBridgeState", node.listener_onMQTTBridgeState);
            }
            
            node.onConnectError();
        }

        setSuccessfulStatus(obj) {
            let node = this;
            node.status(obj);
            node.last_successful_status = obj;
        }
    }

    RED.nodes.registerType('zigbee2mqtt-out', Zigbee2mqttNodeOut);
};
