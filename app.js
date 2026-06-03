'use strict';

const Homey = require('homey');

module.exports = class MitsubishiEchonetApp extends Homey.App {

  async onInit() {
    this.log('Mitsubishi AC (ECHONET Lite) app has been initialised');
  }

};
