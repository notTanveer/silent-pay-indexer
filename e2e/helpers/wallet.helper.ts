import { BIP32Interface, fromSeed } from 'bip32';
import * as ecc from 'tiny-secp256k1';
import {
    initEccLib,
    payments,
    Psbt,
    networks,
    Payment,
    Transaction,
    crypto,
} from 'bitcoinjs-lib';
import { btcToSats } from '@e2e/helpers/common.helper';
import { randomBytes } from 'crypto';
import { toXOnly } from 'bitcoinjs-lib/src/psbt/bip371';
import { BitcoinRPCUtil } from '@e2e/helpers/rpc.helper';
import { ECPairFactory } from 'ecpair';

initEccLib(ecc);
const ECPair = ECPairFactory(ecc);

export enum AddressType {
    P2WPKH = 'P2WPKH',
    P2TR = 'P2TR',
    P2PKH = 'P2PKH',
    P2SH_P2WPKH = 'P2SH_P2WPKH',
}

export type UTXO = {
    txid: string;
    vout: number;
    value: number;
    rawTx: string;
    addressType: AddressType;
    index: number;
};

export type SentTransactionDetails = {
    transaction: Transaction;
    txid: string;
    blockhash: string;
};

export class WalletHelper {
    private readonly root: BIP32Interface;
    private readonly bitcoinRPCUtil: BitcoinRPCUtil;

    constructor() {
        this.root = fromSeed(randomBytes(64), networks.regtest);
        this.bitcoinRPCUtil = new BitcoinRPCUtil();
        initEccLib(ecc);
    }

    async initializeWallet() {
        await this.bitcoinRPCUtil.createWallet('test_wallet');
        await this.bitcoinRPCUtil.loadWallet('test_wallet');
        // ensures 5000 BTC are initially available
        await this.mineBlock(200);
    }

    async getBlockCount() {
        return this.bitcoinRPCUtil.getBlockCount();
    }

    async mineBlock(numOfBlocks: number): Promise<string[]> {
        const walletAddress = await this.bitcoinRPCUtil.getNewAddress();
        return this.bitcoinRPCUtil.mineToAddress(numOfBlocks, walletAddress);
    }

    async addFundToUTXO(payment: Payment, amount: number, addressType: AddressType, index: number): Promise<UTXO> {
        const txid = await this.bitcoinRPCUtil.sendToAddress(
            payment.address,
            amount,
        );

        for (let vout = 0; vout < 2; vout++) {
            const utxo = await this.bitcoinRPCUtil.getTxOut(txid, vout);
            if (
                utxo &&
                utxo.scriptPubKey &&
                utxo.scriptPubKey.address === payment.address
            ) {
                return {
                    txid,
                    vout: vout,
                    value: btcToSats(utxo.value),
                    rawTx: await this.bitcoinRPCUtil.getRawTransaction(txid),
                    addressType,
                    index,
                };
            }
        }

        throw new Error(
            `Cannot find transaction for txid: ${txid}, address: ${payment.address}`,
        );
    }

    generateAddresses(count: number, type: AddressType): Payment[] {
        const outputs: Payment[] = [];
        for (let i = 0; i < count; i++) {
            const path = `m/84'/0'/0'/0/${i}`;
            const child = this.root.derivePath(path);
            let output: Payment;

            switch (type) {
                case AddressType.P2WPKH:
                    output = payments.p2wpkh({
                        pubkey: child.publicKey,
                        network: networks.regtest,
                    });
                    break;
                case AddressType.P2TR:
                    output = payments.p2tr({
                        internalPubkey: toXOnly(child.publicKey),
                        network: networks.regtest,
                    });
                    break;
                case AddressType.P2PKH:
                    output = payments.p2pkh({
                        pubkey: child.publicKey,
                        network: networks.regtest,
                    });
                    break;
                case AddressType.P2SH_P2WPKH:
                    const p2wpkh = payments.p2wpkh({
                        pubkey: child.publicKey,
                        network: networks.regtest,
                    });
                    output = payments.p2sh({
                        redeem: p2wpkh,
                        network: networks.regtest,
                    });
                    break;
                default:
                    throw new Error('Unsupported address type');
            }

            outputs.push(output);
        }
        return outputs;
    }

    async craftAndSendTransaction(
        utxos: UTXO[],
        output: Payment,
        outputValue: number,
        fee: number,
    ): Promise<SentTransactionDetails> {
        const psbt = new Psbt({ network: networks.regtest });

        utxos.forEach((utxo) => {
            const keyPair = this.root.derivePath(getDerivationPath(utxo.addressType, utxo.index));
            const input: any = {
                hash: utxo.txid,
                index: utxo.vout,
            };
            switch (utxo.addressType) {
                case AddressType.P2SH_P2WPKH:
                    const p2wpkh = payments.p2wpkh({
                        pubkey: keyPair.publicKey,
                        network: networks.regtest,
                    });
                    const p2sh = payments.p2sh({
                        redeem: p2wpkh,
                        network: networks.regtest,
                    });
                    input.witnessUtxo = {
                        script: p2sh.output,
                        value: utxo.value,
                    };
                    input.redeemScript = p2sh.redeem.output;
                    break;
                case AddressType.P2WPKH:
                    input.witnessUtxo = {
                        script: payments.p2wpkh({
                            pubkey: keyPair.publicKey,
                            network: networks.regtest,
                        }).output,
                        value: utxo.value,
                    };
                    break;
                case AddressType.P2PKH:
                    input.nonWitnessUtxo = Buffer.from(utxo.rawTx, 'hex');
                    break;
                case AddressType.P2TR:
                    input.witnessUtxo = {
                        script: payments.p2tr({
                            internalPubkey: toXOnly(keyPair.publicKey),
                            network: networks.regtest,
                        }).output,
                        value: utxo.value,
                    };
                    input.tapInternalKey = toXOnly(keyPair.publicKey);
                    break;
            }
            psbt.addInput(input);
        });

        const totalInputValue = utxos.reduce(
            (acc, utxo) => acc + utxo.value,
            0,
        );

        if (totalInputValue < btcToSats(outputValue) + btcToSats(fee)) {
            throw new Error('Insufficient funds');
        }

        psbt.addOutput({
            address: output.address,
            tapInternalKey: output.internalPubkey,
            value: btcToSats(outputValue),
        });

        // Sign the inputs with the corresponding private keys
        utxos.forEach((utxo, index) => {
            let keyPair: any = this.root.derivePath(
                getDerivationPath(utxo.addressType, utxo.index),
            );

            if (utxo.addressType === AddressType.P2TR) {
                keyPair = createTaprootKeyPair(keyPair);
            }
            psbt.signInput(index, keyPair);
        });

        psbt.finalizeAllInputs();

        const transaction = psbt.extractTransaction(true);

        const txid = await this.bitcoinRPCUtil.sendRawTransaction(
            transaction.toHex(),
        );
        const blockhash = (await this.mineBlock(1))[0];

        return { transaction, txid, blockhash };
    }
}

function getDerivationPath(addressType: AddressType, index: number): string {
    switch (addressType) {
        case AddressType.P2PKH:
            return `m/44'/0'/0'/0/${index}`;
        case AddressType.P2SH_P2WPKH:
            return `m/49'/0'/0'/0/${index}`;
        case AddressType.P2WPKH:
            return `m/84'/0'/0'/0/${index}`;
        case AddressType.P2TR:
            return `m/86'/0'/0'/0/${index}`;
        default:
            throw new Error('Unsupported address type');
    }
}

function createTaprootKeyPair(
    keyPair: BIP32Interface,
    network = networks.regtest,
) {
    const taprootKeyPair = ECPair.fromPrivateKey(keyPair.privateKey, {
        compressed: true,
        network: network,
    });

    const tweakedTaprootKey = taprootKeyPair.tweak(
        crypto.taggedHash('TapTweak', toXOnly(keyPair.publicKey)),
    );

    return tweakedTaprootKey;
}

