import { NetworkProvider } from '@ton/blueprint';
import { toNano } from '@ton/core';
import assert from 'assert';

import { getMultiSig, getOrder } from './utils';

export async function run(provider: NetworkProvider) {
    const signerAddr = provider.sender().address;
    assert(signerAddr?.toString(), "Signer address is not set");

    const multisig = await getMultiSig(provider);
    const { nextOrderSeqno } = await multisig.getMultisigData();
    console.log({ nextOrderSeqno })

    // find the order that has not have enough approvals
    const orderConfigs = await Promise.all(Array.from(
        { length: Number(nextOrderSeqno) },
        async (_, i) => {
            const orderAddr = await multisig.getOrderAddress(BigInt(i));
            return {
                multisig: multisig.address,
                orderSeqno: Number(i),
                orderAddr: orderAddr,
            };
        }
    ));
    console.log(orderConfigs)

    const _order = await getOrder(provider, orderConfigs[0]);
    const orderData = await _order.getOrderData();
    console.log(orderData)


    const orderDetails = await Promise.all(orderConfigs.map(async (orderConfig) => {
        const order = await getOrder(provider, orderConfig);
        const orderData = await order.getOrderData();
        return {
            ...orderConfig,
            ...orderData,
            order,
        };
    }));

    console.log(orderDetails)

    // should also check this signer has not approved it
    const pendingOrders = orderDetails.filter(({ threshold, approvals, signers, inited }) =>
        inited &&
        approvals.length < threshold! &&
        signers.includes(signerAddr!) &&
        !approvals[signers.findIndex(s => s === signerAddr)]
    );

    if (pendingOrders.length === 0) {
        console.log('No pending orders found');
        return;
    }

    console.log(`found ${pendingOrders.length} pending orders: ${pendingOrders.map(({ orderAddr }) => orderAddr.toString()).join(', ')}`);
    const { order, orderAddr, signers } = pendingOrders[0];
    const signerIdx = signers.findIndex(s => s === signerAddr);
    assert(signerIdx !== -1, `Signer ${signerAddr?.toString()} not found in signers`);

    console.log(`approving order ${orderAddr.toString()} with signer index ${signerIdx}`);
    await order.sendApprove(provider.sender(), signerIdx, toNano('0.1'));

    console.log('done');
}
