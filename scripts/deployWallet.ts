import {Address, toNano} from '@ton/core';
import {Multisig} from '../wrappers/Multisig';
import {compile, NetworkProvider} from '@ton/blueprint';
import assert from 'assert';
import { getMultiSig } from './utils';

export async function run(provider: NetworkProvider) {
    const signerAddr = provider.sender().address;
    assert(signerAddr?.toString(), "Signer address is not set");

    const multisig = await getMultiSig(provider);

    console.log('sending deploy...')
    await multisig.sendDeploy(provider.sender(), toNano('0.05'));

    console.log('waiting for deploy...')
    await provider.waitForDeploy(multisig.address, 999, 3);

    console.log('deployed address:', multisig.address.toString())
}
