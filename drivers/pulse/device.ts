import { Device, FlowCard, FlowCardTriggerDevice } from 'homey';
import _ from 'lodash';
import moment from 'moment-timezone';
import http from 'http.min';
import { Subscription } from 'apollo-client/util/Observable';
import {
  LiveMeasurement,
  LiveMeasurementResponse,
  TibberApi,
} from '../../lib/tibber';
import { NordPoolPriceResult } from '../../lib/types';
import { startTransaction } from '../../lib/newrelic-transaction';
import { triggerCard } from '../../lib/helpers';

class PulseDevice extends Device {
  #tibber!: TibberApi;
  #deviceId!: string;
  #throttle!: number;
  #currency?: string;
  #cachedNordPoolPrice: { hour: number; price: number } | null = null;
  #area?: string;
  #prevPowerProduction?: number;
  #prevUpdate?: moment.Moment;
  #prevPower?: number;
  #prevCurrent: {
    L1: number | null;
    L2: number | null;
    L3: number | null;
  } = {
    L1: null,
    L2: null,
    L3: null,
  };
  #prevConsumption!: number;
  #prevCost?: number;
  #wsSubscription!: Subscription;
  #resubscribeDebounce!: _.DebouncedFunc<() => void>;
  #triggers!: {
    powerChanged: FlowCardTriggerDevice;
    consumptionChanged: FlowCardTriggerDevice;
    costChanged: FlowCardTriggerDevice;
    currentChanged: {
      L1: FlowCardTriggerDevice;
      L2: FlowCardTriggerDevice;
      L3: FlowCardTriggerDevice;
    };
    dailyConsumptionReport: FlowCardTriggerDevice;
  };

  async onInit() {
    const { id, t: token } = this.getData();

    this.#tibber = new TibberApi(this.log, this.homey.settings, id, token);
    this.#deviceId = id;
    this.#throttle = this.getSetting('pulse_throttle') || 30;

    this.#triggers = {
      powerChanged: this.#trigger('power_changed'),
      consumptionChanged: this.#trigger('consumption_changed'),
      costChanged: this.#trigger('cost_changed'),
      currentChanged: {
        L1: this.#trigger('current.L1_changed'),
        L2: this.#trigger('current.L2_changed'),
        L3: this.#trigger('current.L3_changed'),
      },
      dailyConsumptionReport: this.#trigger('daily_consumption_report'),
    };

    this.log(
      `Tibber pulse device ${this.getName()} has been initialized (throttle: ${
        this.#throttle
      })`,
    );

    // Resubscribe if no data for 10 minutes
    this.#resubscribeDebounce = _.debounce(
      this.#subscribeToLive.bind(this),
      10 * 60 * 1000,
    );
    this.#subscribeToLive();
  }

  async onSettings({
    newSettings,
    changedKeys,
  }: {
    oldSettings: { [key: string]: string };
    newSettings: { [key: string]: string };
    changedKeys: string[];
  }) {
    this.log('Changing pulse settings');

    if (changedKeys.includes('pulse_throttle')) {
      this.log('Updated throttle value: ', newSettings.pulse_throttle);
      this.#throttle = Number(newSettings.pulse_throttle) || 30;
    }
    if (changedKeys.includes('pulse_currency')) {
      this.log('Updated currency value: ', newSettings.pulse_currency);
      this.#currency = newSettings.pulse_currency;
      this.#cachedNordPoolPrice = null;
    }
    if (changedKeys.includes('pulse_area')) {
      this.log('Updated area value: ', newSettings.pulse_area);
      this.#area = newSettings.pulse_area;
      this.#cachedNordPoolPrice = null;
    }
  }

  #subscribeToLive() {
    this.#resubscribeDebounce();
    if (
      this.#wsSubscription &&
      _.isFunction(this.#wsSubscription.unsubscribe)
    ) {
      try {
        this.log('Unsubscribing from previous connection');
        this.#wsSubscription.unsubscribe();
      } catch (e) {
        this.log('Error unsubscribing from previous connection', e);
      }
    }

    this.log('Subscribing to live data for homeId', this.#deviceId);
    this.#wsSubscription = this.#tibber.subscribeToLive(
      this.subscribeCallback.bind(this),
    );
  }

  async subscribeCallback(result: LiveMeasurementResponse) {
    this.#resubscribeDebounce();

    if (
      this.#prevUpdate &&
      moment().diff(this.#prevUpdate, 'seconds') < this.#throttle
    )
      return;

    this.#prevUpdate = moment();

    const currentL1 = result.data?.liveMeasurement?.currentL1;
    const currentL2 = result.data?.liveMeasurement?.currentL2;
    const currentL3 = result.data?.liveMeasurement?.currentL3;

    this.log(
      `Latest current values [L1: ${currentL1}, L2: ${currentL2}, L3: ${currentL3}]`,
    );

    await Promise.all([
      this.#handlePower(result.data?.liveMeasurement),
      this.#handleCurrent(result.data?.liveMeasurement, 'L1'),
      this.#handleCurrent(result.data?.liveMeasurement, 'L2'),
      this.#handleCurrent(result.data?.liveMeasurement, 'L3'),
      this.#handleConsumption(result.data?.liveMeasurement),
      this.#handleCost(result.data?.liveMeasurement),
    ]);
  }

  async #handlePower(
    liveMeasurement: LiveMeasurement | undefined,
  ): Promise<void> {
    const power = liveMeasurement?.power;
    const powerProduction = liveMeasurement?.powerProduction;

    if (powerProduction) this.#prevPowerProduction = powerProduction;

    const measurePower =
      power || -powerProduction! || -this.#prevPowerProduction!;

    this.log(`Set 'measure_power' capability to`, measurePower);
    await this.setCapabilityValue('measure_power', measurePower)
      .catch(console.error)
      .finally(() => {
        if (measurePower !== this.#prevPower) {
          this.#prevPower = measurePower;
          this.log(`Trigger power changed`, measurePower);
          this.#triggers.powerChanged
            .trigger(this, { power: measurePower })
            .catch(console.error);
        }
      });
  }

  async #handleCurrent(
    liveMeasurement: LiveMeasurement | undefined,
    phase: `L${1 | 2 | 3}`,
  ): Promise<void> {
    const current = liveMeasurement?.[`current${phase}`];
    if (current === undefined || current === null) return;

    await this.setCapabilityValue(`measure_current.${phase}`, current)
      .catch(console.error)
      .finally(() => {
        this.log(`Set 'measure_current.${phase}' capability to`, current);
        if (current !== this.#prevCurrent[phase]) {
          this.#prevCurrent[phase] = current!;
          this.log(`Trigger current ${phase} changed`, current);
          this.#triggers.currentChanged[phase]
            .trigger(this, { [`current${phase}`]: current })
            .catch(console.error);
        }
      });
  }

  async #handleConsumption(
    liveMeasurement: LiveMeasurement | undefined,
  ): Promise<void> {
    const consumption = liveMeasurement?.accumulatedConsumption;
    if (consumption === null || consumption === undefined) return;

    const fixedConsumption = Number(consumption.toFixed(2));
    if (fixedConsumption === this.#prevConsumption) return;

    const promises: Promise<void>[] = [];
    if (fixedConsumption < this.#prevConsumption) {
      // Consumption has been reset
      this.log('Triggering daily consumption report');
      promises.push(
        this.#triggers.dailyConsumptionReport
          .trigger(this, {
            consumption: this.#prevConsumption,
            cost: this.#prevCost,
          })
          .catch(console.error),
      );
    }

    this.#prevConsumption = fixedConsumption;
    promises.push(
      this.setCapabilityValue('meter_power', fixedConsumption)
        .catch(console.error)
        .finally(() => {
          this.#triggers.consumptionChanged
            .trigger(this, { consumption: fixedConsumption })
            .catch(console.error);
        }),
    );

    await Promise.all(promises);
  }

  async #handleCost(
    liveMeasurement: LiveMeasurement | undefined,
  ): Promise<void> {
    let cost = liveMeasurement?.accumulatedCost;
    const consumption = liveMeasurement?.accumulatedConsumption;

    if (cost === undefined || cost === null) {
      try {
        const now = moment();
        if (
          this.#cachedNordPoolPrice === null ||
          this.#cachedNordPoolPrice.hour !== now.hour()
        ) {
          const area = this.#area || 'Oslo';
          const currency = this.#currency || 'NOK';
          this.log(
            `Using Nord Pool prices. Currency: ${currency} - Area: ${area}`,
          );
          const priceResult = await startTransaction(
            'GetNordPoolPrices.Pulse',
            'External',
            () =>
              http.json<NordPoolPriceResult>(
                `https://www.nordpoolgroup.com/api/marketdata/page/10?currency=${currency},${currency},${currency},${currency}&endDate=${moment()
                  .tz('Europe/Oslo')
                  .format('DD-MM-YYYY')}`,
              ),
          );
          const filteredRows = (priceResult.data.Rows ?? [])
            .filter(
              (row) =>
                !row.IsExtraRow &&
                moment.tz(row.StartTime, 'Europe/Oslo').isBefore(now) &&
                moment.tz(row.EndTime, 'Europe/Oslo').isAfter(now),
            )
            .map((row) => row.Columns);

          const areaCurrentPrice = filteredRows.length
            ? filteredRows[0].find((a: { Name: string }) => a.Name === area)
            : undefined;

          if (areaCurrentPrice !== undefined) {
            const currentPrice =
              Number(
                areaCurrentPrice.Value.replace(',', '.')
                  .replace(' ', '')
                  .trim(),
              ) / 1000;

            this.#cachedNordPoolPrice = {
              hour: now.hour(),
              price: currentPrice,
            };
            this.log(
              `Found price for ${now.format()} for area ${area} ${currentPrice}`,
            );
          }
        }

        if (!_.isNumber(this.#cachedNordPoolPrice?.price)) return;
        if (consumption === null || consumption === undefined) return;

        cost = this.#cachedNordPoolPrice!.price * consumption!;
      } catch (e) {
        console.error('Error fetching prices from Nord Pool', e);
      }
    }

    if (cost === null || cost === undefined || !_.isNumber(cost)) return;
    const fixedCost = Number(cost.toFixed(2));
    if (fixedCost === this.#prevCost) return;

    this.#prevCost = fixedCost;
    await this.setCapabilityValue('accumulatedCost', fixedCost).catch(
      console.error,
    );
    await this.#triggers.costChanged
      .trigger(this, { cost: fixedCost })
      .catch(console.error);
  }

  onDeleted() {
    if (
      this.#wsSubscription &&
      _.isFunction(this.#wsSubscription.unsubscribe)
    ) {
      try {
        this.log('Unsubscribing from previous connection');
        this.#wsSubscription.unsubscribe();
        this.#resubscribeDebounce.cancel();
      } catch (e) {
        this.log('Error unsubscribing from previous connection', e);
      }
    }
  }

  #trigger(
    name: string,
    runListener?: FlowCard.RunCallback,
  ): FlowCardTriggerDevice {
    return triggerCard(this.homey.flow, name, runListener);
  }
}

module.exports = PulseDevice;
