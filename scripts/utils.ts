import { compile, NetworkProvider } from "@ton/blueprint";
import { Address } from "@ton/core";
import { Multisig } from "../wrappers/Multisig";
import { Order, OrderConfig } from "../wrappers/Order";

export const getMultiSig = async (provider: NetworkProvider) => {
  const multisig_code = await compile('Multisig');
  const signers = [
    Address.parse('EQA4iBbpG_wymsUMOUu9uAz6DdDrqa8kTMnEef2UUDixs6Jl'),
    Address.parse('EQBKY0_HnPLW1kCqmmhtyCp5gAQ08nKklPcvvk2Tb1oTFVR5'),
    Address.parse('EQDHMQvoU87tSaBPCMhcegKC_42AcVXR_lPdUbekMYz1zL3J'),
  ];

  const multiownerWallet = provider.open(Multisig.createFromConfig({
    threshold: 3,
    signers,
    proposers: [],
    allowArbitrarySeqno: false,
  }, multisig_code));

  return multiownerWallet;
}

export const getOrder = async (
  provider: NetworkProvider,
  orderConfig: OrderConfig,
) => {
  const order_code = await compile('Order');
  const order = provider.open(Order.createFromConfig(orderConfig, order_code));
  return order;
}
