/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */


var xmpp_client = require('node-xmpp-client');
var helper = require('./helper.js');
var data = require('./data.js');
var sysap_internal = require('./sysap-internal.js');
var sysap = require('./sysap.js');

/**
 * translates a human readable request into the actual knx commands and calls the "real" set-functions
 * 
 * @param {string} type - what kind of actuator (switch, switchgroup, dimmer, shutter, shuttergroup & scene)
 * @param {string} serialnumber - serial number of the actuator
 * @param {string} channel - channel number of the actuator
 * @param {string} action - what action should be performed (on, off, up, down, stop & set)
 * 
 * @returns {string} either what action was performed or error message
 */
var parse = function (type, serialnumber, channel, action, value) {
	if (type == 'blind') {
		type = 'shutter'; // only different in interface; actuator is the same
	}
	var commands = {
		'switch' : {
			'actions' : {
				'on' : { 'idp0000' : 1 },
				'off' : { 'idp0000' : 0 },
				'toggle' : { 'idp0000' : 'x' }
			},
			'deviceIds' : [
				'B002', // Schaltaktor 4-fach, 16A, REG
				'100E' // Sensor/ Schaltaktor 2/1-fach
			]
		},
		'switchgroup' : {
			'actions' : {
				'on' : { 'odp0002' : 1 },
				'off' : { 'odp0002' : 0 },
				'toggle' : { 'odp0002' : 'x' }
			}
		},
		'dimmer' : {
			'actions' : {
				'on' : { 'idp0000' : 1 },
				'off' : { 'idp0000' : 0 },
				'toggle' : { 'idp0000' : 'x' },
				'up' : { 'idp0001' : 9 }, // relative dimming: 9 means dimm up by 100%
				'down' : { 'idp0001' : 1 }, // relative dimming: 9 means dimm down by 100%
				'stop' : { 'idp0001' : 0 }, // relative dimming: 0 means stop dimming action
				'set' : { 'idp0002' : value }
			},
			'deviceIds' : [
				'101C' // Dimmaktor 4-fach
			]
		},
		'shutter' : {
			'actions' : {
				'up' : { 'idp0000' : 0 },
				'down' : { 'idp0000' : 1 },
				'toggle-up' : { 'idp0000' : 'x-0' },
				'toggle-down' : { 'idp0000' : 'x-1' },
				'pulse-up' : { 'idp0000' : 'p-0' },
				'pulse-down' : { 'idp0000' : 'p-1' },
				'stop' : { 'idp0001' : 1 }
			},
			'deviceIds' : [
				'B001', // Jalousieaktor 4-fach, REG
				'1013' // Sensor/ Jalousieaktor 1/1-fach
			]
		},
		'shuttergroup' : {
			'actions' : {
				'up' : { 'odp0003' : 0 },
				'down' : { 'odp0003' : 1 },
				'stop' : { 'odp0004' : 1 }
			}
		},
		'scene' : {
			'actions' : {
				'set' : { 'odp0000' : 1 }
			}
		},
		'thermostat' : {
			'actions' : {
				'toggle' : { 'idp000B' : 'x' },
				'set' : { 'idp0007' : (value - 21) },
				'up' : { 'idp0007' : '+0.5' },
				'down' : { 'idp0007' : '-0.5' },
				'on' : { 'idp000B' : 1 },
				'off' : { 'idp000B' : 0 },
				'eco-on' : { 'idp0009' : 1 },
				'eco-off' : { 'idp0009' : 0 }
			}
		}
	}
	var actuators = data.getData('actuators');
	
	// error checks
	if (!commands[type]) {
		helper.log.error('parse unknown command: "' + type + '"');
		return 'unknown command: "' + type + '"';
	}
	if (!commands[type].actions[action]) {
		helper.log.error('parse unknown action "' + action + '" for type "' + type + '"');
		return 'unknown action "' + action + '" for type "' + type + '"';
	}
	if (!actuators[serialnumber]) {
		helper.log.error('parse actuator "' + serialnumber + '" not found');
		return 'actuator "' + serialnumber + '" not found';
	}
	if (commands[type].deviceIds) {
		// this check is only valid for "real" actuators, i.e. hardware devices to which an input value is directly send
		// groups and scenes are virtual switches and send output datapoints over the bus
		if (commands[type].deviceIds.indexOf(actuators[serialnumber].deviceId) == -1) {
			helper.log.error('parse actuator "' + serialnumber + '" (' + actuators[serialnumber].typeName + ') is not of type "' + type + '"');
			return 'actuator "' + serialnumber + '" (' + actuators[serialnumber].typeName + ') is not of type "' + type + '"';
		}
	}
	var id = serialnumber;
	if (type == 'scene') {
		serialnumber = actuators[serialnumber].serialNumber;
	}
	
	var datapoint = Object.keys(commands[type].actions[action])[0];
	var value = commands[type].actions[action][datapoint];
	set(serialnumber, channel, datapoint, value);
	return 'set channel ' + channel + ' of ' + type + ' ' + serialnumber + ' (' + actuators[id].typeName + ') to ' + action + ': ' + serialnumber + '/' + channel + '/' + datapoint + ': ' + value;
}

/**
 * sets a knx parameter via xmpp
 * 
 * @param {string} serialnumber - serial number of the actuator
 * @param {string} channel - channel number of the actuator
 * @param {string} datapoint - datapoint of the actuator
 * @param {string} value - the value to set the datapoint to
 */
var set = function (serialnumber, channel, datapoint, value) {
	var d = data.getData('actuators');
	if (value == 'x') {
		if (d[serialnumber].deviceId == '9004') {
			// thermostat
			var current = d[serialnumber].channels[channel].datapoints['odp0006'];
			value = current == 1 ? 0 : 1;
		} else {
			// default: the idp and opd have the same id, so it's possible to just switch the 'i' and 'o'
			var look = 'o' + datapoint.substr(1);
			var current = d[serialnumber].channels[channel].datapoints[look];
			value = current == 1 ? 0 : 1;
		}
	} else if (typeof value === 'string' && value.substr(0, 2) == 'x-') {
		// toggle movement of shutters on and off
		// odp0000 = 0, 1: not moving
		// odp0000 = 3: moving down
		// odp0000 = 2: moving up
		value = value.substr(2);
		if (
			(d[serialnumber].channels[channel].datapoints['odp0000'] == 2 && value == 0) ||
			(d[serialnumber].channels[channel].datapoints['odp0000'] == 3 && value == 1)
		) {
			datapoint = 'idp0001';
			value = 1;
		}
	} else if (typeof value === 'string' && value.substr(0, 2) == 'p-') {
		// activate actuator for 200ms + dead time to rotate blinds step by step
		// odp0000 = 0, 1: not moving
		// odp0000 = 3: moving down
		// odp0000 = 2: moving up
		// pm0006: motor delay in ms
		value = value.substr(2);
		setTimeout(function () {
			set(serialnumber, channel, 'idp0001', 1)
		}, 200 + parseInt(d[serialnumber].channels[channel].datapoints['pm0006']));
	} else if (typeof value === 'string' && (value.substr(0, 1) == '-' || value.substr(0, 1) == '+')) {
		// rise or lower set temperature by x degrees
		var changeValue = parseFloat(value.substr(1)) * (value.substr(0, 1) == '-' ? -1 : 1);
		// value is set as difference to 21°C
		value = parseFloat(d[serialnumber].channels[channel].datapoints['odp0002']) + changeValue - 21;
	}
	var setData = new xmpp_client.Element('iq', {
		type: 'set',
		to: 'mrha@busch-jaeger.de/rpc',
	})
		.c('query', {
			xmlns: 'jabber:iq:rpc'
		})
			.c('methodCall', {})
				.c('methodName', {})
					.t('RemoteInterface.setDatapoint').up()
				.c('params', {})
					.c('param', {})
						.c('value', {})
							.c('string', {})
								.t(serialnumber + '/' + channel + '/' + datapoint)
								.up()
							.up()
						.up()
					.c('param', {})
						.c('value', {})
							.c('string', {})
								.t(value);
	
	helper.log.trace('[SEND] ' + setData.root().toString());
	sysap.sysap.send(setData);
	helper.log.debug('set actuator: ' + serialnumber + '/' + channel + '/' + datapoint + ': ' + value);
}

/**
 * wrapper for updateStructure function in sysap-internal.js
 */
var updateStructure = function () {
	sysap_internal.updateStructure();
}

/**
 * wrapper for master update request (all) function in sysap-internal.js
 */
var updateAll = function () {
	sysap_internal.all();
}

module.exports.parse = parse;
module.exports.set = set;
module.exports.updateStructure = updateStructure;
module.exports.updateAll = updateAll;
