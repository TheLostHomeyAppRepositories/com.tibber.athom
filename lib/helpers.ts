import PairSession from 'homey/lib/PairSession';
import { ClientError } from 'graphql-request/dist/types';
import ManagerFlow from 'homey/manager/flow';
import {
  FlowCard,
  FlowCardAction,
  FlowCardCondition,
  FlowCardTriggerDevice,
} from 'homey';
import { Home, Logger, TibberApi } from './tibber';
import { noticeError, startTransaction } from './newrelic-transaction';

export interface HomeFilterPredicate {
  (home: Home): boolean;
}

export interface HomeDevice {
  name: string;
  data: Home & {
    t: string;
  };
}

export const createListDeviceHandler =
  (
    log: Logger,
    tibber: TibberApi,
    filterPredicate: HomeFilterPredicate,
    deviceNameFormatter: (address: string | undefined) => string,
  ): PairSession.Handler =>
  async (_data): Promise<HomeDevice[]> => {
    try {
      const {
        viewer: { homes },
      } = await startTransaction('GetHomes', 'API', () => tibber.getHomes());

      const devices: HomeDevice[] = homes
        .filter(filterPredicate)
        .map((home) => {
          const address = home.address?.address1;
          return {
            name: deviceNameFormatter(address),
            data: {
              ...home,
              t: tibber.getDefaultToken(),
            },
          };
        });

      devices.sort(sortByName);
      return devices;
    } catch (err) {
      noticeError(err as Error);
      log('Error in list device handler called from `onPair`', err);
      const statusCode = (err as ClientError).response?.status ?? 'unknown';
      throw new Error(`Failed to retrieve data: ${statusCode}`);
    }
  };

const sortByName = (a: { name: string }, b: { name: string }): number => {
  if (a.name < b.name) return -1;
  if (a.name > b.name) return 1;
  return 0;
};

export const triggerCard = (
  homeyFlow: ManagerFlow,
  name: string,
  runListener?: FlowCard.RunCallback,
): FlowCardTriggerDevice => {
  const card = homeyFlow.getDeviceTriggerCard(name);
  if (runListener === undefined) return card;
  card.registerRunListener(runListener);
  return card;
};

export const conditionCard = (
  homeyFlow: ManagerFlow,
  name: string,
  runListener?: FlowCard.RunCallback,
): FlowCardCondition => {
  const card = homeyFlow.getConditionCard(name);
  if (runListener === undefined) return card;
  card.registerRunListener(runListener);
  return card;
};

export const actionCard = (
  homeyFlow: ManagerFlow,
  name: string,
  runListener?: FlowCard.RunCallback,
): FlowCardAction => {
  const card = homeyFlow.getActionCard(name);
  if (runListener === undefined) return card;
  card.registerRunListener(runListener);
  return card;
};
