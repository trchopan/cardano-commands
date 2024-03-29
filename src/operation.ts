import {partial} from 'lodash';
import {execToStr} from './helpers';

export enum Operation {
    UnlockPrivFolder = 'Unlock priv folder',
    LockPrivFolder = 'Lock priv folder',
    NewOrUpdateStakePool = 'New or Update Stake Pool',
    SendADA = 'Send ADA',
    SendMA = 'Send multi asset token',
    MintMA = 'Mint multi asset token',
    GetUTXO = 'Get UTXO of address',
    RotateKESKey = 'Rotate KES Key',
    RetirePool = 'Retire Pool',
    SendOperationKeysToCore = 'Send Operation Keys to Core',
    ExtractWalletKeys = 'Extract wallet keys from mnemonic',
    Exit = 'Exit',
}

export interface Relay {
    host: string;
    port: number;
}

export interface PoolData {
    poolPledgeAda: number;
    poolCostAda: number;
    poolMargin: number;
    relays: Relay[];
    metadataUrl: string;
}

export interface PoolMetadata {
    name: string;
    description: string;
    ticker: string;
    homepage: string;
    extended: string;
}

export interface Config {
    privOwnerWallet: string;
    privPoolName: string;
    coreApi: string;
    coreSocketPath: string;
    protocolParametersPath: string;
    shelleyGenesis: string;
    networkMagic: string;
    poolData: PoolData;
    poolMetadata: PoolMetadata;
}

export const getPushFile = (
    isGet: boolean,
    params: {
        core: {addr: string; filePath: string};
        secret: {filePath: string};
    }
) => {
    const {core, secret} = params;
    const cmd = isGet
        ? `scp ${core.addr}:${core.filePath} ${secret.filePath}`
        : `scp ${secret.filePath} ${core.addr}:${core.filePath}`;
    execToStr(cmd);
};

export const getFromCore = partial(getPushFile, true);
export const pushToCore = partial(getPushFile, false);

export const newPoolKeysPushToCore = [
    'kes.vkey',
    'vrf.skey',
    'node.cert',
    'pool.cert',
    'delegation.cert',
    'stake.cert',
];

export const rotateKeysPushToCore = ['kes.vkey', 'node.cert'];
