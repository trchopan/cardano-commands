import fs from 'fs';
import {execSync} from 'child_process';
import inquirer from 'inquirer';
import {repeat, sumBy} from 'lodash';
import {Config} from './operation';
import {CardanocliJs} from 'cardanocli-js';
import {format} from 'date-fns';

// A small hack for getting correct type as `cardanocli-js` is written in javascript
const CardanocliJs_ = require('cardanocli-js');

export const color = {
  yellow: (msg: string) => `\x1b[33m${msg}\x1b[0m`,
  cyan: (msg: string) => `\x1b[36m${msg}\x1b[0m`,
  green: (msg: string) => `\x1b[32m${msg}\x1b[0m`,
  red: (msg: string) => `\x1b[31m${msg}\x1b[0m`,
  blue: (msg: string) => `\x1b[34m${msg}\x1b[0m`,
};

export const execToStr = (cmd: string) => {
  if (process.env['DEBUG']) {
    console.log('>', cmd);
  }
  return String(execSync(cmd));
};

export const backupFiles = (
  paths: string[],
  backupSuffix: string = format(new Date(), 'yyyy-MM-dd_HH-mm-ss')
) => {
  for (const p of paths) {
    execSync(`cp ${p} ${p}_${backupSuffix}`);
  }
};

export const backupThenRemoveFiles = (
  paths: string[],
  backupSuffix?: string
) => {
  backupFiles(paths, backupSuffix);
  for (const p of paths) {
    execSync(`rm -rf ${p}`);
  }
};

export const getCardanoNodeVersion = () =>
  execToStr(`cardano-node version | awk '/cardano/ {print $2}'`).trim();

export const getCardanoCliVersion = () =>
  execToStr(`cardano-cli version | awk '/cardano/ {print $2}'`).trim();

export const parseConfig = () => {
  const configFile = process.argv[2];
  if (!configFile) {
    console.log(`Usage: npm run <core|secret> -- config.example.json`);
    process.exit(1);
  }
  const parseHome = (_: string) => _.replace('~', process.env['HOME']);
  try {
    const _ = JSON.parse(String(fs.readFileSync(configFile)));
    for (const p of ['coreSocketPath']) {
      _[p] = parseHome(_[p]);
    }
    return _ as Config;
  } catch (err) {
    console.error(err);
    console.log('Unable to parse config.');
    console.log(
      'Please check the `config.example.json` and setup a `config.json` file in current directory.'
    );
    process.exit(1);
  }
};

export const getCardanoCli = (config: Config) =>
  new CardanocliJs_({
    network: config.networkMagic,
    era: 'alonzo',
    shelleyGenesisPath: config.shellyGenesis,
    socketPath: config.coreSocketPath,
  }) as CardanocliJs;

export const inquirerConfirm = async (message: string) =>
  (
    await inquirer.prompt([
      {
        type: 'confirm',
        name: 'confirm',
        message,
        default: false,
      },
    ])
  ).confirm as boolean;

export const inquirerSelect = async <T>(
  message: string,
  list: T[],
  filter?: (val: string) => string
) =>
  (
    await inquirer.prompt([
      {
        type: 'list',
        name: 'select',
        message,
        choices: list,
        filter,
      },
    ])
  ).select as T;

export const inquirerInput = async <T>(
  msg: string,
  validate?: (
    val: T,
    answers?: T[]
  ) => boolean | string | Promise<boolean | string>
) =>
  (
    await inquirer.prompt([
      {
        type: 'input',
        name: 'input',
        message: msg,
        validate,
      },
    ])
  ).input as T;

export const inquirerPassword = async (
  msg: string,
  validate: (
    val: string,
    answers?: string[]
  ) => boolean | string | Promise<boolean | string>
) =>
  (
    await inquirer.prompt([
      {
        type: 'password',
        name: 'password',
        message: msg,
        mask: '',
        validate,
      },
    ])
  ).password as string;

export const headLines = (...msg: string[]) => {
  const MAX_LINE = 80;

  const notAnsiRegex = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;
  const msgLength =
    sumBy(msg, m => m.replace(notAnsiRegex, '').length) + msg.length;
  const padding = MAX_LINE / 2 - msgLength / 2;

  console.log(repeat('=', MAX_LINE));
  console.log(repeat(' ', padding > 0 ? padding : 0), ...msg);
  console.log(repeat('=', MAX_LINE));
};
