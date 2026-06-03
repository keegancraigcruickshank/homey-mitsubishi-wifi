'use strict';

/**
 * ECHONET Lite property (EPC) codes for the "Home air conditioner" class
 * (class group 0x01, class 0x30) as implemented by Mitsubishi Electric
 * Wi-Fi adapters (MAC-558/567/568/578/588IF-E).
 *
 * Reference: ECHONET Lite specification, Appendix "Detailed Requirements for
 * ECHONET Device Objects", section 3.x (Home air conditioner class).
 */
const EPC = {
  OPERATION_STATUS: 0x80, // 0x30 = ON, 0x31 = OFF
  OPERATION_MODE: 0xB0, // auto/cool/heat/dry/fan
  TARGET_TEMPERATURE: 0xB3, // °C, unsigned 0x00-0x32
  ROOM_TEMPERATURE: 0xBB, // °C, signed int8
  OUTDOOR_TEMPERATURE: 0xBE, // °C, signed int8 (0x7E = undefined)
  FAN_SPEED: 0xA0, // air flow rate
  AUTO_DIRECTION: 0xA1, // automatic air flow direction
  SWING_MODE: 0xA3, // automatic swing of air flow direction
  VANE_VERTICAL: 0xA4, // air flow direction (vertical)
};

const POWER = { ON: 0x30, OFF: 0x31 };

// Operation mode (EPC 0xB0)
const MODE_TO_BYTE = { auto: 0x41, cool: 0x42, heat: 0x43, dry: 0x44, fan: 0x45 };
const MODE_FROM_BYTE = {
  0x40: 'auto', // "other" -> treat as auto
  0x41: 'auto',
  0x42: 'cool',
  0x43: 'heat',
  0x44: 'dry',
  0x45: 'fan',
};

// Fan speed (EPC 0xA0). Mitsubishi units expose auto + a handful of steps;
// we surface a friendly subset and fold the 8 ECHONET levels back onto it.
const FAN_TO_BYTE = { auto: 0x41, quiet: 0x31, low: 0x32, medium: 0x34, high: 0x36, max: 0x38 };
const FAN_FROM_BYTE = {
  0x41: 'auto',
  0x31: 'quiet',
  0x32: 'low',
  0x33: 'low',
  0x34: 'medium',
  0x35: 'medium',
  0x36: 'high',
  0x37: 'high',
  0x38: 'max',
};

// Vertical vane position (EPC 0xA4)
const VANE_POS_TO_BYTE = { top: 0x41, upper: 0x44, middle: 0x43, lower: 0x45, bottom: 0x42 };
const VANE_POS_FROM_BYTE = { 0x41: 'top', 0x44: 'upper', 0x43: 'middle', 0x45: 'lower', 0x42: 'bottom' };

/**
 * Convert a friendly vane value into the ECHONET writes required to achieve it.
 * Returns an array of { epc, edt } commands applied in order.
 */
function vaneToCommands(value) {
  if (value === 'auto') {
    return [
      { epc: EPC.SWING_MODE, edt: Buffer.from([0x31]) }, // swing off
      { epc: EPC.AUTO_DIRECTION, edt: Buffer.from([0x41]) }, // direction auto
    ];
  }
  if (value === 'swing') {
    return [{ epc: EPC.SWING_MODE, edt: Buffer.from([0x41]) }]; // vertical swing
  }
  const pos = VANE_POS_TO_BYTE[value];
  if (pos === undefined) return [];
  return [
    { epc: EPC.SWING_MODE, edt: Buffer.from([0x31]) }, // swing off
    { epc: EPC.AUTO_DIRECTION, edt: Buffer.from([0x42]) }, // direction non-auto
    { epc: EPC.VANE_VERTICAL, edt: Buffer.from([pos]) },
  ];
}

/**
 * Derive the friendly vane value from the raw 0xA1/0xA3/0xA4 property buffers.
 */
function vaneFromBytes(a1, a3, a4) {
  if (a3 && a3.length && [0x41, 0x42, 0x43].includes(a3[0])) return 'swing';
  if (a1 && a1.length && a1[0] === 0x41) return 'auto';
  if (a4 && a4.length && VANE_POS_FROM_BYTE[a4[0]]) return VANE_POS_FROM_BYTE[a4[0]];
  return null;
}

/** Interpret a single byte as a signed 8-bit temperature. */
function signed8(byte) {
  return byte > 127 ? byte - 256 : byte;
}

module.exports = {
  EPC,
  POWER,
  MODE_TO_BYTE,
  MODE_FROM_BYTE,
  FAN_TO_BYTE,
  FAN_FROM_BYTE,
  VANE_POS_TO_BYTE,
  VANE_POS_FROM_BYTE,
  vaneToCommands,
  vaneFromBytes,
  signed8,
};
