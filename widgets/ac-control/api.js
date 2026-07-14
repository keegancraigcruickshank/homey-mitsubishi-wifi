'use strict';

const DRIVER_ID = 'mitsubishi-ac';
const TEMP_MIN = 16;
const TEMP_MAX = 31;
const MODES = ['auto', 'cool', 'heat', 'dry', 'fan'];
const FANS = ['auto', 'quiet', 'low', 'medium', 'high', 'max'];

function getDevice(homey, deviceId) {
  if (!deviceId) throw new Error('No device selected');
  const driver = homey.drivers.getDriver(DRIVER_ID);
  const device = driver.getDevices().find((d) => d.getId() === deviceId);
  if (!device) throw new Error('Device not found');
  return device;
}

module.exports = {

  async getState({ homey, query }) {
    const device = getDevice(homey, query.deviceId);
    return {
      name: device.getName(),
      available: device.getAvailable(),
      on: device.getCapabilityValue('onoff'),
      mode: device.getCapabilityValue('ac_mode'),
      target: device.getCapabilityValue('target_temperature'),
      room: device.getCapabilityValue('measure_temperature'),
      outdoor: device.getCapabilityValue('measure_temperature.outdoor'),
      fan: device.getCapabilityValue('fan_speed'),
    };
  },

  async setOnOff({ homey, query, body }) {
    const device = getDevice(homey, query.deviceId);
    await device.triggerCapabilityListener('onoff', body.value === true);
    return { ok: true };
  },

  async setTarget({ homey, query, body }) {
    const device = getDevice(homey, query.deviceId);
    const value = Math.max(TEMP_MIN, Math.min(TEMP_MAX, Number(body.value)));
    if (Number.isNaN(value)) throw new Error('Invalid temperature');
    await device.triggerCapabilityListener('target_temperature', value);
    return { ok: true };
  },

  async setMode({ homey, query, body }) {
    const device = getDevice(homey, query.deviceId);
    if (!MODES.includes(body.value)) throw new Error(`Invalid mode: ${body.value}`);
    await device.triggerCapabilityListener('ac_mode', body.value);
    return { ok: true };
  },

  async setFan({ homey, query, body }) {
    const device = getDevice(homey, query.deviceId);
    if (!FANS.includes(body.value)) throw new Error(`Invalid fan speed: ${body.value}`);
    await device.triggerCapabilityListener('fan_speed', body.value);
    return { ok: true };
  },

};
