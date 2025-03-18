import { Address, beginCell, toNano, internal as internal_relaxed } from '@ton/core';
import {Multisig} from '../wrappers/Multisig';
import {compile, NetworkProvider} from '@ton/blueprint';
import assert from 'assert';
import { randomAddress } from '@ton/test-utils';
import { getMultiSig } from './utils';
export async function run(provider: NetworkProvider) {
    const signerAddr = provider.sender().address;
    assert(signerAddr?.toString(), "Signer address is not set");

    const multisig = await getMultiSig(provider);

    const actionMsg = {         // the actual action to be executed, send 0.00123 TON to a random address
        type: "transfer" as const,
        sendMode: 1,            // sender pays fees
        message: internal_relaxed({
            to: signerAddr?.toString()!,
            value: toNano('0.00123'),
            body: beginCell().storeUint(12345, 32).endCell()
        })
    };

    console.log('sending new order...')
    const validUntil = Math.floor(Date.now() / 1000 + 3600);
    await multisig.sendNewOrder(
        provider.sender(),
        [actionMsg],
        validUntil,     // expired in hour
        toNano('0.03'), // ton amount
        0,              // index
        true            // is signer
    );

}
