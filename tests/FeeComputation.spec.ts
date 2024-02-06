import { Blockchain, SandboxContract, TreasuryContract, prettyLogTransactions, BlockchainTransaction } from '@ton/sandbox';
import { beginCell, Cell, internal, toNano, Transaction, storeAccountStorage, storeMessage, Slice, Message, Dictionary, storeStateInit, fromNano } from '@ton/core';
import { Multisig, TransferRequest, Action, MultisigConfig } from '../wrappers/Multisig';
import { Order } from '../wrappers/Order';
import { Op } from '../wrappers/Constants';
import '@ton/test-utils';
import { compile } from '@ton/blueprint';
import { randomAddress } from '@ton/test-utils';
import { MsgPrices, getMsgPrices, collectCellStats, computeFwdFees, computeMessageForwardFees, shr16ceil } from '../gasUtils';

export const computedGeneric = (trans:Transaction) => {
    if(trans.description.type !== "generic")
        throw("Expected generic transaction");
    if(trans.description.computePhase.type !== "vm")
        throw("Compute phase expected")
    return trans.description.computePhase;
};
export const storageGeneric = (trans:Transaction) => {
    if(trans.description.type !== "generic")
        throw("Expected generic transaction");
    if(trans.description.computePhase.type !== "vm")
        throw("Compute phase expected")
    return trans.description.storagePhase;
};

describe('FeeComputation', () => {
    let multisig_code: Cell;
    let order_code: Cell;
    let msgPrices: MsgPrices;

    let curTime : () => number;

    beforeAll(async () => {
        multisig_code = await compile('Multisig');
        order_code = await compile('Order');
    });

    let blockchain: Blockchain;
    let multisigWallet: SandboxContract<Multisig>;
    let deployer : SandboxContract<TreasuryContract>;
    let second : SandboxContract<TreasuryContract>;
    let proposer : SandboxContract<TreasuryContract>;
    let signers  : Array<SandboxContract<TreasuryContract>>;

    let testOrderEstimate: (wallet: SandboxContract<Multisig>, actions: Action[], time: number) => Promise<void>;

    beforeEach(async () => {
        blockchain = await Blockchain.create();

        const _libs = Dictionary.empty(Dictionary.Keys.BigUint(256), Dictionary.Values.Cell());
        let code_raw = await compile('Order');
        _libs.set(BigInt(`0x${(await compile('Order')).hash().toString('hex')}`), code_raw);
        const libs = beginCell().storeDictDirect(_libs).endCell();
        blockchain.libs = libs;

        deployer = await blockchain.treasury('deployer');
        second = await blockchain.treasury('second');
        proposer = await blockchain.treasury('proposer');

        // Total max 255 signers
        signers  = [deployer, second, ...await blockchain.createWallets(253)];

        let config = {
            threshold: 2,
            signers: signers.map(s => s.address), // [deployer.address, second.address],
            proposers: [proposer.address],
            allowArbitrarySeqno: false,
        };

        multisigWallet = blockchain.openContract(Multisig.createFromConfig(config, multisig_code));
        msgPrices        = getMsgPrices(blockchain.config, 0);

        const deployResult = await multisigWallet.sendDeploy(deployer.getSender(), toNano('1'));

        curTime = () => blockchain.now ?? Math.floor(Date.now() / 1000);
        // Stop ticking
        blockchain.now = curTime();

        testOrderEstimate = async (wallet, actions, time) => {
            const expTime = curTime() + time;
            let orderEstimateOnContract = await wallet.getOrderEstimate(actions, BigInt(expTime));
            const res = await wallet.sendNewOrder(deployer.getSender(), actions, expTime, orderEstimateOnContract);

            /*
              tx0 : external -> treasury
              tx1: treasury -> multisig
              tx2: multisig -> order
            */

            let MULTISIG_INIT_ORDER_GAS = computedGeneric(res.transactions[1]).gasUsed;
            let MULTISIG_INIT_ORDER_FEE = computedGeneric(res.transactions[1]).gasFees;
            let ORDER_INIT_GAS = computedGeneric(res.transactions[2]).gasUsed;
            let ORDER_INIT_GAS_FEE = computedGeneric(res.transactions[2]).gasFees;

            let orderAddress = await wallet.getOrderAddress(0n);
            let order = blockchain.openContract(Order.createFromAddress(orderAddress));
            let orderBody = (await order.getOrderData()).order;
            let orderBodyStats = collectCellStats(orderBody!, []);

            let smc = await blockchain.getContract(orderAddress);
            let accountStorage = beginCell().store(storeAccountStorage(smc.account.account!.storage)).endCell();
            let orderAccountStorageStats = collectCellStats(accountStorage, []);

            let orderStateOverhead = orderAccountStorageStats.sub(orderBodyStats);
            // {bits: orderAccountStorageStats.bits - orderBodyStats.bits, cells: orderAccountStorageStats.cells - orderBodyStats.cells};

            let multisigToOrderMessage = res.transactions[2].inMessage!;
            let multisigToOrderMessageStats = computeMessageForwardFees(msgPrices, multisigToOrderMessage).stats;
            let initOrderStateOverhead = multisigToOrderMessageStats.sub(orderBodyStats);
            // {bits: multisigToOrderMessageStats.bits - orderBodyStats.bits, cells: multisigToOrderMessageStats.cells - orderBodyStats.cells};

            // console.log("initOrderStateOverhead", initOrderStateOverhead);

            const firstApproval = await order.sendApprove(deployer.getSender(), 0);
            blockchain.now = expTime;
            const secondApproval = await order.sendApprove(second.getSender(), 1);

            expect(secondApproval.transactions).toHaveTransaction({
                from: order.address,
                to: wallet.address,
                op: Op.multisig.execute,
                success: true,
                outMessagesCount: actions.length
            });

            /*
              tx0 : external -> treasury
              tx1: treasury -> order
              tx2: order -> treasury (approve)
              tx3: order -> multisig
              tx4+: multisig -> destination
            */
            let orderToMultiownerMessage      = secondApproval.transactions[3].inMessage!;
            let orderToMultiownerMessageStats = computeMessageForwardFees(msgPrices, orderToMultiownerMessage).stats;
            // console.log("Order to multisig stats:", orderToMultiownerMessageStats);
            // console.log("Order body stats:", orderBodyStats);
            let orderToMultiownerMessageOverhead = orderToMultiownerMessageStats.sub(orderBodyStats);
            // {bits: orderToMultiownerMessageStats.bits - orderBodyStats.bits, cells: orderToMultiownerMessageStats.cells - orderBodyStats.cells};


            let ORDER_EXECUTE_GAS = computedGeneric(secondApproval.transactions[1]).gasUsed;
            let ORDER_EXECUTE_FEE = computedGeneric(secondApproval.transactions[1]).gasFees;
            let MULTISIG_EXECUTE_GAS = computedGeneric(secondApproval.transactions[3]).gasUsed;
            let MULTISIG_EXECUTE_FEE = computedGeneric(secondApproval.transactions[3]).gasFees;
            // console.log("orderToMultiownerMessageOverhead", orderToMultiownerMessageOverhead);

            // collect data in one console.log
            console.log(`
            MULTISIG_INIT_ORDER_GAS: ${MULTISIG_INIT_ORDER_GAS}
            ORDER_INIT_GAS: ${ORDER_INIT_GAS}
            ORDER_EXECUTE_GAS: ${ORDER_EXECUTE_GAS} MULTISIG_EXECUTE_GAS: ${MULTISIG_EXECUTE_GAS}
            orderStateOverhead: ${orderStateOverhead}
            initOrderStateOverhead: ${initOrderStateOverhead}
            orderToMultiownerMessageOverhead: ${orderToMultiownerMessageOverhead}
            `);

            let gasEstimate = shr16ceil((MULTISIG_INIT_ORDER_GAS + ORDER_INIT_GAS + ORDER_EXECUTE_GAS + MULTISIG_EXECUTE_GAS) * 65536000n);
            let gasFees     = MULTISIG_INIT_ORDER_FEE + ORDER_INIT_GAS_FEE + ORDER_EXECUTE_FEE + MULTISIG_EXECUTE_FEE;
            expect(gasFees).toEqual(gasEstimate);
            // expect(gasFees).toEqual(orderEstimateOnContract.gas);

            // blockchain.verbosity = {vmLogs:"vm_logs_verbose", print: true, debugLogs: true, blockchainLogs: true};
            let actualFwd   = computeFwdFees(msgPrices, orderToMultiownerMessageStats.cells, orderToMultiownerMessageStats.bits) +
                              computeFwdFees(msgPrices, multisigToOrderMessageStats.cells, multisigToOrderMessageStats.bits);
            // console.log("Actual fwd:", actualFwd);
            let fwdEstimate = 2n * 1000000n +
            BigInt((2n * orderBodyStats.bits + initOrderStateOverhead.bits + orderToMultiownerMessageOverhead.bits) +
            (2n * orderBodyStats.cells + initOrderStateOverhead.cells + orderToMultiownerMessageOverhead.cells) * 100n) * 1000n;

            // console.log("fwdEstimate:", fwdEstimate);
            expect(fwdEstimate).toEqual(actualFwd);
            //expect(fwdEstimate).toEqual(orderEstimateOnContract.fwd);

            let storageEstimate = shr16ceil((orderBodyStats.bits +orderStateOverhead.bits + (orderBodyStats.cells + orderStateOverhead.cells) * 500n) * BigInt(time));
            const storagePhase  = storageGeneric(secondApproval.transactions[1]);
            const actualStorage = storagePhase?.storageFeesCollected;
            console.log("Storage estimates:", storageEstimate, actualStorage);
            expect(storageEstimate).toEqual(actualStorage);
            // expect(storageEstimate).toEqual(orderEstimateOnContract.storage);
            let manualFees = gasEstimate + fwdEstimate + storageEstimate;
            console.log("orderEstimates", orderEstimateOnContract, manualFees);
            // It's ok if contract overestimates fees a little
            expect(manualFees).toBeLessThanOrEqual(orderEstimateOnContract);
            const feesDelta = orderEstimateOnContract - manualFees;
            if(feesDelta > 0) {
                console.log("Contract overestimated fees by:", fromNano(feesDelta));
            }
        }
    });

    it('should send new order with contract estimated message value', async () => {
        const testAddr = randomAddress();
        const testMsg: TransferRequest = {type:"transfer", sendMode: 1, message: internal({to: testAddr, value: toNano('0.015'), body: beginCell().storeUint(12345, 32).endCell()})};
        const orderList:Array<Action> = [testMsg,/*testMsg, testMsg, testMsg2*/];
        let timeSpan  = 365 * 24 * 3600;
        await testOrderEstimate(multisigWallet, orderList, timeSpan);
    });

    it('common cases gas fees multisig', async () => {
        const assertMultisig = async (threshold: number, total: number, txcount: number, lifetime: number, signer_creates: boolean) => {
            let totalGas = 0n;
            const testWallet = await blockchain.treasury('test_wallet'); // Make sure we don't bounce
            const signers = await blockchain.createWallets(total);
            const config : MultisigConfig = {
                threshold,
                signers : signers.map(x => x.address),
                proposers: [proposer.address],
                allowArbitrarySeqno: false
            };

            const multisig = blockchain.openContract(Multisig.createFromConfig(config, multisig_code));


            const creator   = signer_creates ? signers[0] : proposer;
            const signerIdx = signer_creates ? 1 : 0;
            let res = await multisig.sendDeploy(deployer.getSender(), toNano('10'));
            expect(res.transactions).toHaveTransaction({
                from: deployer.address,
                to: multisig.address,
                deploy: true,
                success: true
            });

            const dataBefore   = await multisig.getMultisigData();
            const initSeqno    = dataBefore.nextOrderSeqno;
            const orderContract = blockchain.openContract(Order.createFromAddress(await multisig.getOrderAddress(initSeqno)));

            blockchain.now = curTime();
            const testMsg: TransferRequest = {type:"transfer", sendMode: 1, message: internal({to: testWallet.address, value: toNano('0.015'), body: beginCell().storeUint(12345, 32).endCell()})};
            const actions: Array<TransferRequest> = [];
            for (let i = 0; i < txcount; i++) {
                actions.push(testMsg);
            }
            res = await multisig.sendNewOrder(creator.getSender(), actions, blockchain.now + lifetime);
            expect(res.transactions).toHaveTransaction({
                from: creator.address,
                to: multisig.address,
                success: true
            });
            expect(res.transactions).toHaveTransaction({
                from: multisig.address,
                to: orderContract.address,
                deploy: true,
                success: true
            });

            const summTx = (summ: bigint, tx: BlockchainTransaction) => summ + tx.totalFees.coins;
            totalGas += res.transactions.reduce(summTx, 0n);

            blockchain.now += lifetime;
            for (let i = signerIdx; i < threshold; i++ ) {
                res = await orderContract.sendApprove(signers[i].getSender(), i);
                totalGas += res.transactions.reduce(summTx, 0n);
            }
            expect(res.transactions).toHaveTransaction({
                from: orderContract.address,
                to: multisig.address,
                op: Op.multisig.execute,
                success: true
            });
            expect(res.transactions).toHaveTransaction({
                from: multisig.address,
                to: testWallet.address,
                success: true
            });
            expect(res.transactions).not.toHaveTransaction({
                actionResultCode: (x) => x! != 0
            });


            return totalGas;
        };


        const week = 3600 * 24 * 7;
        const gas1 = await assertMultisig(7, 10, 1, week, false);
        const gas2 = await assertMultisig(2, 3, 1, week, true);
        const gas3 = await assertMultisig(1, 3, 1, week, true);
        const gas4 = await assertMultisig(7, 10, 100, week, false);

        console.log("Multisig 7/10 1 transfer 1 week proposer:", gas1);
        console.log("Multisig 2/3 1 transfer 1 week signer:", gas2);
        console.log("Multisig 1/3 1 transfer 1 week signer:", gas3);
        console.log("Multisig 7/10 100 transfer 1 week proposer:", gas4);
    });

    it('should be enough for 75 years', async () => {
        const testAddr = randomAddress();
        const testMsg: TransferRequest = {type:"transfer", sendMode: 1, message: internal({to: testAddr, value: toNano('0.015'), body: beginCell().storeUint(12345, 32).endCell()})};
        const testMsg2: TransferRequest = {type:"transfer", sendMode: 1, message: internal({to: randomAddress(), value: toNano('0.017'), body: beginCell().storeUint(123425, 32).endCell()})};
        const orderList:Array<Action> = [testMsg];
        let timeSpan  = 365 * 24 * 3600 * 75;
        const expTime = Math.floor(Date.now() / 1000) + timeSpan;
        let orderEstimateOnContract = await multisigWallet.getOrderEstimate(orderList, BigInt(expTime));
        const res = await multisigWallet.sendNewOrder(deployer.getSender(), orderList, expTime, orderEstimateOnContract + 1n);

        let orderAddress = await multisigWallet.getOrderAddress(0n);
        let order = blockchain.openContract(Order.createFromAddress(orderAddress));

        expect(res.transactions).toHaveTransaction({
            from: multisigWallet.address,
            to: order.address,
            success: true,
        });

        const firstApproval = await order.sendApprove(deployer.getSender(), 0);
        blockchain.now = expTime - 10;
        const secondApproval = await order.sendApprove(second.getSender(), 1);

        expect(secondApproval.transactions).toHaveTransaction({
            from: order.address,
            to: multisigWallet.address
        });

        const storagePhase  = storageGeneric(secondApproval.transactions[1]);
        const actualStorage = storagePhase?.storageFeesCollected;
        console.log("Storage estimates:", actualStorage);
    });

});
