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
  const {data} = await api.get<{utxo: CardanocliJs.Utxo[]}>(
    `/query-utxo/${paymentAddress}`
  );
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
  const value = {};
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

  console.log(
    'Balance:',
    cardanocliJs.toAda(balance['lovelace']).toLocaleString()
  );
  console.log('Deposit:', cardanocliJs.toAda(deposit).toLocaleString());
  console.log('Transaction Fee:', cardanocliJs.toAda(fee).toLocaleString());
  console.log(
    'Remain Balance:',
    cardanocliJs.toAda(tx.txOut[0].value.lovelace).toLocaleString()
  );

  const shouldProceed = await inquirerConfirm('Should proceed transaction?');
  if (!shouldProceed) {
    return '';
  }
  const txBody = cardanocliJs.transactionBuildRaw({...tx, fee});
  const txSigned = cardanocliJs.transactionSign({
    txBody,
    signingKeys,
  });
  return await transactionSubmit(txSigned);
};

const registerStakeKeyCert = async (
  wallet: CardanocliJs.Wallet,
  stakeAddressDeposit: number
) => {
  console.log(color.cyan('Registering Stake Key Cert'));
  // Get the stake certificate or create one
  const stakeCert =
    wallet.stake.cert ||
    cardanocliJs.stakeAddressRegistrationCertificate(wallet.name);

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
  const {poolPledgeAda, poolCostAda, poolMargin, relays, metadataUrl} =
    config.poolData;

  const poolData: CardanocliJs.StakePoolRegistrationOptions = {
    pledge: cardanocliJs.toLovelace(poolPledgeAda),
    margin: poolMargin,
    cost: cardanocliJs.toLovelace(poolCostAda),
    owners: [wallet.stake.vkey],
    rewardAccount: wallet.stake.vkey,
    relays,
    url: metadataUrl,
    metaHash: cardanocliJs.stakePoolMetadataHash(
      JSON.stringify(config.poolMetadata, null, 2)
    ),
  };

  const poolCert = cardanocliJs.stakePoolRegistrationCertificate(
    pool.name,
    poolData
  );

  const isFirstRegister = await inquirerConfirm(
    'Is this the first pool registration and deposit'
  );

  const delegCert = cardanocliJs.stakeAddressDelegationCertificate(
    wallet.name,
    pool.id
  );

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

const newOrUpdateStakePool = async () => {
  const {ownerWallet, poolName} = config;
  try {
    // Check if able to load the wallet
    cardanocliJs.wallet(ownerWallet);
  } catch (err) {
    if (
      (await inquirerConfirm('Not found Owner Wallet. Should I create it')) ===
      false
    ) {
      process.exit(0);
    }
    const payment = cardanocliJs.addressKeyGen(ownerWallet);
    const stake = cardanocliJs.stakeAddressKeyGen(ownerWallet);
    cardanocliJs.stakeAddressBuild(ownerWallet);
    cardanocliJs.addressBuild(ownerWallet, {
      paymentVkey: payment.vkey,
      stakeVkey: stake.vkey,
    });
  }

  try {
    // Check if able to load the pool
    cardanocliJs.pool(poolName);
  } catch (err) {
    if (
      (await inquirerConfirm('Not found Pool. Should I create it?')) === false
    ) {
      process.exit(0);
    }
    cardanocliJs.nodeKeyGen(poolName);
    cardanocliJs.nodeKeyGenVRF(poolName);
  }

  const wallet = cardanocliJs.wallet(ownerWallet);
  console.log('Wallet payment address:', wallet.paymentAddr);
  const pool = cardanocliJs.pool(poolName);
  console.log('Pool Id:', pool.id);
  await newKESKeyAndOpCert(poolName);

  const protocolParams = await getProtocolParams();
  const stakeAddressInfo = await getStakeAddressInfo(wallet.stakingAddr);

  if (!isEmpty(stakeAddressInfo)) {
    console.log(color.yellow('Stake Key Certificate already registered'));
    console.log(stakeAddressInfo);
  } else {
    await registerStakeKeyCert(wallet, protocolParams.stakeAddressDeposit);
  }

  if (!pool.node?.skey) {
    console.log(color.red('Pool node skey not exists'));
    process.exit(1);
  }

  await registerPoolCert(wallet, pool, protocolParams.stakePoolDeposit);
};

const rotateKESKey = async () => {
  const {poolName} = config;
  await newKESKeyAndOpCert(poolName);
};

const retirePool = async () => {
  const {ownerWallet, poolName} = config;
  const {wallet, pool} = (() => {
    try {
      return {
        wallet: cardanocliJs.wallet(ownerWallet),
        pool: cardanocliJs.pool(poolName),
      };
    } catch (err) {
      console.log(color.red('Cannot load pool or wallet'));
      process.exit(1);
    }
  })();

  const currentEpoch = Math.floor(await getCurrentEpoch());
  const protocolParams = await getProtocolParams();
  const poolRetireMaxEpoch = protocolParams.poolRetireMaxEpoch;
  const minRetirementEpoch = currentEpoch + 1;
  const maxRetirementEpoch = currentEpoch + poolRetireMaxEpoch;

  const retireEpoch = await inquirerInput(
    `Enter the epoch to be retired ${minRetirementEpoch} ~ ${maxRetirementEpoch}`,
    (val: number) =>
      (val > minRetirementEpoch && val < maxRetirementEpoch) ||
      `retirement epoch must be between ${minRetirementEpoch} ~ ${maxRetirementEpoch}`
  );

  const deregistrationCert = cardanocliJs.stakePoolDeregistrationCertificate(
    poolName,
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

enum Priv {
  Pool = 'pool',
  Wallet = 'wallet',
}

const lockPrivFolder = (priv: Priv, passphrase: string) => {
  console.log(color.red('Locking:'), priv);
  const outputFile = `./priv/${priv}.tar.gz.gpg`;
  if (fs.existsSync(outputFile)) {
    backupThenRemoveFiles([outputFile]);
  }
  execToStr(
    `tar czf - -C ./priv ${priv} | gpg -c --passphrase "${passphrase}" -o ${outputFile}`
  );
  execToStr(`rm -rf ./priv/${priv}`);
};

const passphraseValidator = (v: string) =>
  v.length > 3 || 'must enter pass phrase more than 3 characters';

const unlockPrivFolder = async (priv: Priv) => {
  const outputFile = `./priv/${priv}.tar.gz.gpg`;
  if (!fs.existsSync(outputFile)) return '';

  const passphrase = await inquirerPassword(
    `Enter ${priv} pass phrase:`,
    passphraseValidator
  );

  console.log(color.red('Unlocking:'), priv);
  execToStr(
    `gpg -d --passphrase "${passphrase}" ${outputFile}| tar xz -C ./priv`
  );
  return passphrase;
};

const unlockPrivPool = () => unlockPrivFolder(Priv.Pool);
const unlockPrivWallet = () => unlockPrivFolder(Priv.Wallet);

const sendKeysToCore = async () => {
  const {poolName} = config;
  const keys = [
    'kes.skey',
    'vrf.skey',
    'node.cert',
    'node.counter',
    'node.skey',
  ]
    .map(k => `./priv/pool/${poolName}/${poolName}.${k}`)
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

const checkAndLockPriv = async ({
  poolPassphrase,
  walletPassphrase,
}: {
  poolPassphrase: string;
  walletPassphrase: string;
}) => {
  for (const p of [Priv.Pool, Priv.Wallet]) {
    if (fs.existsSync(`./priv/${p}`)) {
      const passphrase = p === Priv.Pool ? poolPassphrase : walletPassphrase;
      const newPassphrase = await (async () => {
        const shouldChangePassphrase =
          !passphrase ||
          (passphrase &&
            (await inquirerConfirm(
              `Do you want to change pass phrase for ${p}`
            )));
        return shouldChangePassphrase
          ? await inquirerPassword(
              `Enter new ${p} pass phrase`,
              passphraseValidator
            )
          : passphrase;
      })();
      lockPrivFolder(p, newPassphrase);
    }
  }
};

const extractWalletKeys = async () => {
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

  const networkSelect = await inquirerSelect('Select network', [
    'testnet',
    'mainnet',
  ]);

  const [network, magic] =
    networkSelect === 'mainnet'
      ? ['1', '--mainnet']
      : ['0', '--testnet-magic 1097911063'];

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
  walletKeys.forEach(key =>
    execSync(`mv ${key} ${walletDir}/${walletName}.${key}`)
  );
};

const operationRunner = async (operation: Operation) => {
  let poolPassphrase = '';
  let walletPassphrase = '';

  try {
    switch (operation) {
      case Operation.NewOrUpdateStakePool:
        poolPassphrase = await unlockPrivPool();
        walletPassphrase = await unlockPrivWallet();
        await newOrUpdateStakePool();
        return;
      case Operation.RotateKESKey:
        poolPassphrase = await unlockPrivPool();
        await rotateKESKey();
        return;
      case Operation.RetirePool:
        poolPassphrase = await unlockPrivPool();
        walletPassphrase = await unlockPrivWallet();
        await retirePool();
        return;
      case Operation.SendOperationKeysToCore:
        poolPassphrase = await unlockPrivPool();
        await sendKeysToCore();
        return;
      case Operation.ExtractWalletKeys:
        walletPassphrase = await unlockPrivWallet();
        await extractWalletKeys();
        return;
      default:
        return;
    }
  } catch (err) {
    // Silence the error for not logging the pass phrase out
  } finally {
    checkAndLockPriv({poolPassphrase, walletPassphrase});
  }
};

const run = async () => {
  headLines(color.yellow('Pool setup tool'));

  const operation = await inquirerSelect('Select an operation', [
    Operation.NewOrUpdateStakePool,
    Operation.RotateKESKey,
    Operation.RetirePool,
    Operation.SendOperationKeysToCore,
    Operation.ExtractWalletKeys,
    Operation.Exit,
  ]);

  if (
    operation !== Operation.ExtractWalletKeys &&
    (await versionCheck()) === false
  ) {
    process.exit(1);
  }

  await operationRunner(operation);
};

run();
