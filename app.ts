import sourceMapSupport from 'source-map-support';
import { App } from 'homey';
import { Mutable } from 'type-fest';
import { attributes } from './lib/newrelic-transaction';
import * as appJson from './app.json';

sourceMapSupport.install();

class TibberApp extends App {
  async onInit() {
    this.log('Tibber app is running...');

    const { version: firmwareVersion } = this.homey;
    const { version: appVersion } = appJson;

    this.log(`firmwareVersion: `, firmwareVersion);
    this.log(`appVersion: `, appVersion);

    (attributes.firmwareVersion as Mutable<string>) = firmwareVersion;
    (attributes.appVersion as Mutable<string>) = appVersion;

    const v = this.homey.settings.get('v');
    if (v !== 2) {
      this.log('Cleaning logs');
      this.homey.settings.set('v', 2);
      this.cleanupLogs('*').catch(console.error);
    }
  }

  async cleanupLogs(prefix: string) {
    if (prefix !== '*') return;
    const logs = await this.homey.insights.getLogs();

    await Promise.all(
      logs
        .filter(({ name }) => name.startsWith(prefix))
        .map((log) => {
          console.log('Deleting log', log.name);
          return this.homey.insights.deleteLog(log);
        }),
    );
  }
}

// workaround for `The class exported in '<filepath>' must extend Homey.<classname>` error
module.exports = TibberApp;