import fs from 'fs';
import express from 'express';
import morgan from 'morgan';
import {color, getCardanoCli, getCardanoNodeVersion, parseConfig} from './helpers';
import {CardanocliJs} from 'cardanocli-js';

const app = express();
app.use(express.json());

const logger = morgan('tiny');
app.use(logger);

const config = parseConfig();

const cardanocliJs: CardanocliJs = getCardanoCli(config);

app.get('/cardano-version', async (req, res) => {
    const version = getCardanoNodeVersion();
    res.status(200).json({version});
});

app.get('/current-epoch', async (req, res) => {
    const epoch = cardanocliJs.currentEpoch();
    res.status(200).json({epoch});
});

app.get('/start-kes-period', async (req, res) => {
    const startKESPeriod = cardanocliJs.KESPeriod();
    res.status(200).json({startKESPeriod});
});

app.get('/query-stake-address/:address', async (req, res) => {
    const address = req.params.address;
    try {
        const stakeAddr = cardanocliJs.queryStakeAddressInfo(address);
        res.status(200).json({stakeAddr});
    } catch (err) {
        res.status(500).json({error: 'please check the core server for error log'});
    }
});

app.get('/query-protocol-params', async (req, res) => {
    const params = cardanocliJs.queryProtocolParameters();
    res.status(200).json(params);
});

app.get('/query-utxo/:paymentAddr', async (req, res) => {
    const paymentAddr = req.params.paymentAddr;
    const utxo = cardanocliJs.queryUtxo(paymentAddr);
    res.status(200).json({utxo});
});

app.get('/query-tip', async (req, res) => {
    const tip = cardanocliJs.queryTip();
    res.status(200).json(tip);
});

app.post('/submit-tx', async (req, res) => {
    const {tx} = req.body;
    const result = cardanocliJs.transactionSubmit(tx);
    res.status(200).json(result);
});

app.post('/receive-core-keys', (req, res) => {
    const {kes, vrf, nodeCert, nodeCounter, nodeSkey, metadata} = req.body;

    const keyConfig = [
        {body: kes, path: './priv/kes.skey'},
        {body: vrf, path: './priv/vrf.skey'},
        {body: nodeCert, path: './priv/node.cert'},
        {body: nodeCounter, path: './priv/node.counter'},
        {body: nodeSkey, path: './priv/node.skey'},
        {body: metadata, path: './priv/metadata.json'},
    ];

    for (const {body, path} of keyConfig) {
        if (body) {
            fs.writeFileSync(path, body);
        }
    }

    res.status(200).json({success: true});
});

const port = 3000;

app.listen(port, () => {
    console.log('Core API server is running on port: ', color.yellow(String(port)));
});
