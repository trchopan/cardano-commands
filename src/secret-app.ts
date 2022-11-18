import fs from 'fs';
import {execSync} from 'child_process';
import {CardanocliJs} from 'cardanocli-js';
import axios from 'axios';
import {
    headLines,
    color,
    parseConfig,
    getCardanoNodeVersion,
    getCardanoCliVersion,
    inquirerSelect,
    inquirerConfirm,
    inquirerPassword,
    backupThenRemoveFiles,
    execToStr,
    inquirerInput,
} from './helpers';
import {Operation} from './operation';
import {isEmpty} from 'lodash';

// A small hack for getting correct type as `cardanocli-js` is written in javascript
const CardanocliJs_ = require('cardanocli-js');

const OUTPUT_PRIV_GPG = './priv.tar.gz.gpg';

const config = parseConfig();
const cardanocliJs: CardanocliJs = new CardanocliJs_({
    network: config.networkMagic,
    era: 'alonzo',
});

const api = axios.create({
    baseURL: config.coreApi,
    timeout: 10_000,
});

const getCurrentEpoch = async () => {
    const {data} = await api.get<{epoch: number}>('/current-epoch');
    return data.epoch;
};

const getCardanoVersion = async () => {
    try {
        const {data} = await api.get<{version: string}>('/cardano-version');
        return data.version;
    } catch (err) {
        const errMsg = 'Cannot query version';
        console.log(color.red(errMsg));
        throw new Error(errMsg);
    }
};

const getStartKESPeriod = async () => {
    const {data} = await api.get<{startKESPeriod: number}>('/start-kes-period');
    return data.startKESPeriod;
};

const getUtxo = async (paymentAddress: string) => {
    const {data} = await api.get<{utxo: CardanocliJs.Utxo[]}>(`/query-utxo/${paymentAddress}`);
    return data.utxo;
};

const getStakeAddressInfo = async (stakeAddress: string) => {
    const {data} = await api.get(`/query-stake-address/${stakeAddress}`);
    return data.stakeAddr;
};

const getProtocolParams = async () => {
    const {data} = await api.get<{
        stakeAddressDeposit: number;
        stakePoolDeposit: number;
        poolRetireMaxEpoch: number;
    }>('/query-protocol-params');
    return data;
};

const transactionSubmit = async (txPath: string) => {
    const {data} = await api.post('/submit-tx', {
        tx: JSON.parse(String(fs.readFileSync(txPath))),
    });
    return data;
};

// Taken from wallet.ballance()
const getBalance = (utxo: CardanocliJs.Utxo[]) => {
    const value: {lovelace?: number} = {};
    utxo.forEach(utxo => {
        Object.keys(utxo.value).forEach(asset => {
            if (!value[asset]) value[asset] = 0;
            value[asset] += utxo.value[asset];
        });
    });

    return {utxo: utxo, value};
};

const versionCheck = async (): Promise<boolean> => {
    console.log(color.cyan('Checking versions'));

    const versionsToCheck = [
        {item: 'cardano-node', version: getCardanoNodeVersion()},
        {item: 'cardano-cli', version: getCardanoCliVersion()},
    ];

    try {
        const cardanoVersion = await getCardanoVersion();
        for (const v of versionsToCheck) {
            if (v.version !== cardanoVersion) {
                console.log(
                    color.red(`${v.item} version is not match.`),
                    `current version: ${v.version}, api version: ${cardanoVersion}`
                );
                return false;
            }
            console.log(color.green('Good'), v.item, v.version);
        }

        return true; // Everything good
    } catch (err) {
        return false; // Version check failed
    }
};

const newKESKeyAndOpCert = async (poolName: string) => {
    const pool = cardanocliJs.pool(poolName);
    const poolKESKeys = [pool.kes?.skey, pool.kes?.vkey];
    const isExistKES = poolKESKeys.map(k => fs.existsSync(k)).includes(true);
    const confirmRenew =
        isExistKES &&
        (await inquirerConfirm(
            'There are existing KES keys. Should I backup and create new KES key?'
        ));

    if (confirmRenew) {
        backupThenRemoveFiles(poolKESKeys);
    }

    if (!isExistKES || confirmRenew) {
        cardanocliJs.nodeKeyGenKES(poolName);
        const startKESPeriod = await getStartKESPeriod();
        cardanocliJs.nodeIssueOpCert(poolName, startKESPeriod);
    }
};

const mkCertificateDepositTx = async ({
    paymentAddr,
    deposit,
    certs,
    signingKeys,
}: {
    paymentAddr: string;
    deposit: number;
    certs: CardanocliJs.Certificate[];
    signingKeys: string[];
}) => {
    const utxo = await getUtxo(paymentAddr);
    const balance = getBalance(utxo).value;
    if ((balance?.lovelace || 0) < 3) {
        throw new Error(`Wallet balance is too low ${JSON.stringify(balance)}`);
    }

    const tx: CardanocliJs.Transaction = {
        txIn: utxo as unknown as CardanocliJs.TxIn[], // TODO: Converter between Utxo and TxIn
        txOut: [
            {
                address: paymentAddr,
                value: {
                    ...balance,
                    lovelace: balance['lovelace'] - deposit,
                },
                datumHash: '',
            },
        ],
        certs,
    };

    const txBodyRaw = cardanocliJs.transactionBuildRaw(tx);
    const fee = cardanocliJs.transactionCalculateMinFee({
        ...tx,
        txBody: txBodyRaw,
        witnessCount: 2,
    });
    tx.txOut[0].value.lovelace -= fee;

    console.log('Balance:', cardanocliJs.toAda(balance['lovelace']));
    console.log('Deposit:', cardanocliJs.toAda(deposit));
    console.log('Transaction Fee:', cardanocliJs.toAda(fee));
    console.log('Remain Balance:', cardanocliJs.toAda(tx.txOut[0].value.lovelace));

    const shouldProceed = await inquirerConfirm('Should proceed transaction?');
    if (!shouldProceed) {
        process.exit(0);
    }
    const txBody = cardanocliJs.transactionBuildRaw({...tx, fee});
    const txSigned = cardanocliJs.transactionSign({
        txBody,
        signingKeys,
    });
    return await transactionSubmit(txSigned);
};

const registerStakeKeyCert = async (wallet: CardanocliJs.Wallet, stakeAddressDeposit: number) => {
    console.log(color.cyan('Registering Stake Key Cert'));
    // Get the stake certificate or create one
    const stakeCert =
        wallet.stake.cert || cardanocliJs.stakeAddressRegistrationCertificate(wallet.name);

    const txHash = await mkCertificateDepositTx({
        paymentAddr: wallet.paymentAddr,
        deposit: stakeAddressDeposit,
        certs: [{cert: stakeCert}],
        signingKeys: [wallet.payment.skey, wallet.stake.skey],
    });

    if (txHash) {
        console.log(color.green('Tx submited. TxHash:'), txHash);
    } else {
        console.log(color.red('Transaction not submited'));
    }
};

const registerPoolCert = async (
    wallet: CardanocliJs.Wallet,
    pool: CardanocliJs.Pool,
    stakePoolDeposit: number
) => {
    console.log(color.cyan('Registering Pool Cert and Delegation Cert'));
    const {poolPledgeAda, poolCostAda, poolMargin, relays, metadataUrl} = config.poolData;

    const poolData: CardanocliJs.StakePoolRegistrationOptions = {
        pledge: cardanocliJs.toLovelace(poolPledgeAda),
        margin: poolMargin,
        cost: cardanocliJs.toLovelace(poolCostAda),
        owners: [wallet.stake.vkey],
        rewardAccount: wallet.stake.vkey,
        relays,
        url: metadataUrl,
        metaHash: cardanocliJs.stakePoolMetadataHash(JSON.stringify(config.poolMetadata, null, 2)),
    };

    const poolCert = cardanocliJs.stakePoolRegistrationCertificate(pool.name, poolData);

    const isFirstRegister = await inquirerConfirm(
        'Is this the first pool registration and deposit?' +
            ` If it is, a stake pool deposit ${stakePoolDeposit} will be charged.`
    );

    const delegCert = cardanocliJs.stakeAddressDelegationCertificate(wallet.name, pool.id);

    const txHash = await mkCertificateDepositTx({
        paymentAddr: wallet.paymentAddr,
        deposit: isFirstRegister ? stakePoolDeposit : 0,
        certs: [{cert: poolCert}, {cert: delegCert}],
        signingKeys: [wallet.payment.skey, wallet.stake.skey, pool.node.skey],
    });

    if (txHash) {
        console.log(color.green('Tx submited. TxHash:'), txHash);
    } else {
        console.log(color.red('Transaction not submited'));
    }
};

const newOrUpdateStakePoolRunner = async () => {
    const {privOwnerWallet, privPoolName} = config;
    try {
        // Check if able to load the wallet
        cardanocliJs.wallet(privOwnerWallet);
    } catch (err) {
        if ((await inquirerConfirm('Not found Owner Wallet. Should I create it')) === false) {
            process.exit(0);
        }
        const payment = cardanocliJs.addressKeyGen(privOwnerWallet);
        const stake = cardanocliJs.stakeAddressKeyGen(privOwnerWallet);
        cardanocliJs.stakeAddressBuild(privOwnerWallet);
        cardanocliJs.addressBuild(privOwnerWallet, {
            paymentVkey: payment.vkey,
            stakeVkey: stake.vkey,
        });
    }

    try {
        // Check if able to load the pool
        cardanocliJs.pool(privPoolName);
    } catch (err) {
        if ((await inquirerConfirm('Not found Pool. Should I create it?')) === false) {
            process.exit(0);
        }
        cardanocliJs.nodeKeyGen(privPoolName);
        cardanocliJs.nodeKeyGenVRF(privPoolName);
    }

    const wallet = cardanocliJs.wallet(privOwnerWallet);
    console.log('Wallet payment address:', wallet.paymentAddr);
    const pool = cardanocliJs.pool(privPoolName);
    console.log('Pool Id:', pool.id);
    await newKESKeyAndOpCert(privPoolName);

    const {stakeAddressDeposit, stakePoolDeposit} = await getProtocolParams();
    const stakeAddressInfo = await getStakeAddressInfo(wallet.stakingAddr);

    if (!isEmpty(stakeAddressInfo)) {
        console.log(color.yellow('Stake Key Certificate already registered'));
        console.log(stakeAddressInfo);
    } else {
        await registerStakeKeyCert(wallet, stakeAddressDeposit);
    }

    if (!pool.node?.skey) {
        console.log(color.red('Pool node skey not exists'));
        process.exit(1);
    }

    await registerPoolCert(wallet, pool, stakePoolDeposit);
};

const rotateKESKeyRunner = async () => {
    const {privPoolName} = config;
    await newKESKeyAndOpCert(privPoolName);
};

const retirePoolRunner = async () => {
    const {privOwnerWallet, privPoolName} = config;
    const {wallet, pool} = (() => {
        try {
            return {
                wallet: cardanocliJs.wallet(privOwnerWallet),
                pool: cardanocliJs.pool(privPoolName),
            };
        } catch (err) {
            console.log(color.red('Cannot load pool or wallet'));
            process.exit(1);
        }
    })();

    const currentEpoch = Math.floor(await getCurrentEpoch());
    const {poolRetireMaxEpoch} = await getProtocolParams();
    const minRetirementEpoch = currentEpoch + 1;
    const maxRetirementEpoch = currentEpoch + poolRetireMaxEpoch;

    const retireEpoch = await inquirerInput(
        `Enter the epoch to be retired (${minRetirementEpoch} < retire epoch < ${maxRetirementEpoch})`,
        (val: number) =>
            (val > minRetirementEpoch && val < maxRetirementEpoch) ||
            `retirement epoch must be between ${minRetirementEpoch} ~ ${maxRetirementEpoch}`
    );

    const deregistrationCert = cardanocliJs.stakePoolDeregistrationCertificate(
        privPoolName,
        retireEpoch
    );

    if (!pool.node?.skey) {
        console.log(color.red('Pool node skey not exists'));
        return;
    }

    const txHash = await mkCertificateDepositTx({
        paymentAddr: wallet.paymentAddr,
        deposit: 0,
        certs: [{cert: deregistrationCert}],
        signingKeys: [wallet.payment.skey, pool.node.skey],
    });

    if (txHash) {
        console.log(color.green('Tx submited. TxHash:'), txHash);
    } else {
        console.log(color.red('Transaction not submited'));
    }
};

const lockPrivFolderRunner = async () => {
    const passphrase = await inquirerPassword('Enter pass phrase:', passphraseValidator);

    console.log(color.red('Locking priv folder'));
    if (fs.existsSync(OUTPUT_PRIV_GPG)) {
        backupThenRemoveFiles([OUTPUT_PRIV_GPG]);
    }
    execToStr(
        `tar czf - -C ./priv pool wallet | gpg -c --passphrase "${passphrase}" -o ${OUTPUT_PRIV_GPG}`
    );
    execToStr(`rm -rf ./priv/pool`);
    execToStr(`rm -rf ./priv/wallet`);
};

const passphraseValidator = (v: string) =>
    v.length > 3 || 'must enter pass phrase more than 3 characters';

const unlockPrivFolderRunner = async () => {
    if (!fs.existsSync(OUTPUT_PRIV_GPG)) throw new Error(`not found ${OUTPUT_PRIV_GPG}`);

    const passphrase = await inquirerPassword('Enter pass phrase:', passphraseValidator);

    console.log(color.red('Unlocking priv folder'));
    execToStr(`gpg -d --passphrase "${passphrase}" ${OUTPUT_PRIV_GPG}| tar xz -C ./priv`);
};

const sendKeysToCoreRunner = async () => {
    const {privPoolName} = config;
    const keys = ['kes.skey', 'vrf.skey', 'node.cert', 'node.counter', 'node.skey']
        .map(k => `./priv/pool/${privPoolName}/${privPoolName}.${k}`)
        .map(p => {
            if (!fs.existsSync(p)) {
                console.log(color.red(`${p} key does not exist`));
                process.exit(1);
            }
            return fs.readFileSync(p).toString();
        });
    await api.post('/receive-core-keys', {
        kes: keys[0],
        vrf: keys[1],
        nodeCert: keys[2],
        nodeCounter: keys[3],
        nodeSkey: keys[4],
        metadata: JSON.stringify(config.poolMetadata, null, 2),
    });
    console.log(color.green('Keys sent to core successfully'));
};

const extractWalletKeysRunner = async () => {
    console.log(
        color.red(
            'WARNING: this extraction will overwrite the priv/wallet.tar.gz file. Please backup before continue.'
        )
    );

    // Checking avaiable tool
    const home = process.env['HOME'];
    const CADDR = `${home}/cardano-wallet/cardano-address`;
    const CCLI = `${home}/cardano-wallet/cardano-cli`;
    const BECH32 = `${home}/cardano-wallet/bech32`;

    for (const tool of [CADDR, CCLI, BECH32]) {
        if (!fs.existsSync(tool)) {
            console.log(color.red(`Missing tool ${tool}`));
            process.exit(1);
        }
    }

    const networkSelect = await inquirerSelect('Select network', ['testnet', 'mainnet']);

    const [network, magic] =
        networkSelect === 'mainnet' ? ['1', '--mainnet'] : ['0', '--testnet-magic 2']; // preview: 2, prerod: 1

    console.log(
        color.red(
            'Please make sure next step is safe, you are about to provide the 15 or 24 words mnemonics.' +
                'This can restore the access to your wallet.'
        )
    );

    const mnemonic = await inquirerPassword(
        'Mnemonics:',
        v =>
            [15, 24].includes(v.split(' ').length) ||
            'Must be 15 or 24 mnemonics separate by single white space'
    );
    // Extract the keys using bech32
    const extractCmds = [
        `echo ${mnemonic} | ${CADDR} key from-recovery-phrase Shelley > root.prv`,
        `cat root.prv |${CADDR} key child 1852H/1815H/0H/2/0 > stake.xprv`,
        `cat root.prv |${CADDR} key child 1852H/1815H/0H/0/0 > payment.xprv`,
        `cat payment.xprv | \
${CADDR} key public | \
tee payment.xpub | \
${CADDR} address payment --network-tag ${network} | \
${CADDR} address delegation $(cat stake.xprv | ${CADDR} key public | tee stake.xpub) | \
tee base.addr_candidate | \
${CADDR} address inspect`,
        `echo "Generated from 1852H/1815H/0H/{0,2}/0"`,
        `echo cat base.addr_candidate`,
    ];

    extractCmds.forEach(execSync);

    const [seskey, peskey] = ['stake', 'payment'].map(key =>
        execToStr(
            `echo $(cat ${key}.xprv | ${BECH32} | cut -b -128 )$( cat ${key}.xpub | ${BECH32})`
        ).trim()
    );

    fs.writeFileSync(
        'stake.skey',
        `{
    "type": "StakeExtendedSigningKeyShelley_ed25519_bip32",
    "description": "",
    "cborHex": "5880${seskey}"
}
`
    );

    fs.writeFileSync(
        'payment.skey',
        `{
    "type": "PaymentExtendedSigningKeyShelley_ed25519_bip32",
    "description": "Payment Signing Key",
    "cborHex": "5880${peskey}"
}
`
    );

    // Build the keys using cardano-cli

    const buildVkeyCmds = [
        `"${CCLI}" shelley key verification-key --signing-key-file stake.skey --verification-key-file stake.evkey`,
        `"${CCLI}" shelley key verification-key --signing-key-file payment.skey --verification-key-file payment.evkey`,
        `"${CCLI}" shelley key non-extended-key --extended-verification-key-file payment.evkey --verification-key-file payment.vkey`,
        `"${CCLI}" shelley key non-extended-key --extended-verification-key-file stake.evkey --verification-key-file stake.vkey`,
        `"${CCLI}" shelley stake-address build --stake-verification-key-file stake.vkey ${magic} > stake.addr`,
        `"${CCLI}" shelley address build --payment-verification-key-file payment.vkey ${magic} > payment.addr`,
        `"${CCLI}" shelley address build --payment-verification-key-file payment.vkey --stake-verification-key-file stake.vkey ${magic} > base.addr`,
        `echo "base.addr_candidate" $(cat base.addr_candidate)`,
        `echo "base.addr" $(cat base.addr)`,
        `mv base.addr payment.addr`,
    ];

    buildVkeyCmds.forEach(execSync);

    // Cleanup the bech32 keys

    const cleanupFiles = [
        'root.prv',
        'base.addr_candidate',
        'stake.xprv',
        'stake.evkey',
        'stake.xpub',
        'payment.xprv',
        'payment.evkey',
        'payment.xpub',
    ];
    execSync(`rm ${cleanupFiles.join(' ')}`);

    console.log('Extract success');

    // Put the keys in priv format and gpg tar it

    const walletName = await inquirerInput('Wallet name');
    const walletDir = `./priv/wallet/${walletName}`;
    const walletKeys = [
        'payment.addr',
        'payment.vkey',
        'payment.skey',
        'stake.addr',
        'stake.vkey',
        'stake.skey',
    ];
    execSync(`mkdir -p ${walletDir}`);
    walletKeys.forEach(key => execSync(`mv ${key} ${walletDir}/${walletName}.${key}`));
};

const getUtxoRunner = async () => {
    const addr = await inquirerInput<string>('addr = ');
    const utxo = await getUtxo(addr);
    console.log(utxo);
};

const mintMARunner = async () => {
    const {privOwnerWallet} = config;
    const wallet = (() => {
        try {
            // Check if able to load the wallet
            return cardanocliJs.wallet(privOwnerWallet);
        } catch (err) {
            throw new Error('unable to load wallet');
        }
    })();

    const mintScript = {
        keyHash: cardanocliJs.addressKeyHash(wallet.name),
        type: 'sig',
    };
    const policy = cardanocliJs.transactionPolicyid(mintScript);
    console.log(color.blue('mintScript'), mintScript);
    console.log(color.blue('policy'), policy);

    const realAssetName = await inquirerInput<string>('Asset name');
    const assetName = Buffer.from(realAssetName).toString('hex');
    const coinName = policy + '.' + assetName;
    console.log(color.blue('asset'));
    console.log(realAssetName);
    console.log(coinName);

    if ((await inquirerConfirm('Continue?')) === false) {
        process.exit(0);
    }
    const utxo = await getUtxo(wallet.paymentAddr);
    const balance = getBalance(utxo).value;
    if ((balance?.lovelace || 0) < 1) {
        throw new Error(`Wallet balance is too low ${JSON.stringify(balance)}`);
    }

    const amountStr = await inquirerInput<string>('Amount to mint:');
    const coinAmount = (balance[coinName] || 0) + parseInt(amountStr);
    const tx: CardanocliJs.Transaction = {
        txIn: utxo as unknown as CardanocliJs.TxIn[], // TODO: Converter between Utxo and TxIn
        txOut: [
            {
                address: wallet.paymentAddr,
                value: {
                    ...balance,
                    [coinName]: coinAmount,
                },
                datumHash: '',
            },
        ],
        mint: [
            {
                action: 'mint',
                quantity: (100).toString(),
                asset: coinName,
                script: mintScript,
                datum: '',
                redeemer: '',
                executionUnits: '',
            },
        ],
    };

    console.log(color.blue('Transaction:'), JSON.stringify(tx, null, 2));
    if ((await inquirerConfirm('Continue?')) === false) {
        process.exit(0);
    }

    // Create transaction
    let raw = cardanocliJs.transactionBuildRaw(tx);
    let fee = cardanocliJs.transactionCalculateMinFee({
        ...tx,
        txBody: raw,
        witnessCount: 2,
    });
    tx.txOut[0].value.lovelace -= fee;
    const txBody = cardanocliJs.transactionBuildRaw({...tx, fee});

    // Sign transaction
    const txSigned = cardanocliJs.transactionSign({
        txBody,
        signingKeys: [wallet.payment.skey, wallet.stake.skey],
    });

    const txHash = await transactionSubmit(txSigned);
    if (txHash) {
        console.log(color.green('Tx submited. TxHash:'), txHash);
    } else {
        console.log(color.red('Transaction not submited'));
    }
};

const todoOperation = () => {
    console.log('TODO please check back next version');
    return Promise.resolve();
};

const operationMaps: {type: Operation; runner: () => Promise<void>}[] = [
    {type: Operation.UnlockPrivFolder, runner: unlockPrivFolderRunner},
    {type: Operation.LockPrivFolder, runner: lockPrivFolderRunner},

    {type: Operation.NewOrUpdateStakePool, runner: newOrUpdateStakePoolRunner},
    {type: Operation.RotateKESKey, runner: rotateKESKeyRunner},

    {type: Operation.SendADA, runner: todoOperation},
    {type: Operation.SendMA, runner: todoOperation},
    {type: Operation.MintMA, runner: mintMARunner},
    {type: Operation.GetUTXO, runner: getUtxoRunner},

    {type: Operation.RetirePool, runner: retirePoolRunner},
    {type: Operation.SendOperationKeysToCore, runner: sendKeysToCoreRunner},
    {type: Operation.ExtractWalletKeys, runner: extractWalletKeysRunner},

    {type: Operation.Exit, runner: () => process.exit(0)},
];

const operationRunner = async (operation: Operation) => {
    try {
        await operationMaps.find(v => v.type === operation)!.runner();
    } catch (err) {
        // Silence the error for not logging the pass phrase out
        console.log('>>>', err);
    }
};

const run = async () => {
    headLines(color.yellow('Pool setup tool'));

    const operation = await inquirerSelect(
        'Select an operation',
        operationMaps.map(v => v.type)
    );

    if (operation !== Operation.ExtractWalletKeys && (await versionCheck()) === false) {
        process.exit(1);
    }

    await operationRunner(operation);
};

run();
