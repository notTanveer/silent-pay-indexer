import { randomBytes } from 'crypto';
import { mnemonicToSeedSync, generateMnemonic } from 'bip39';
import { BIP32Factory } from 'bip32';
import * as ecc from 'tiny-secp256k1';
import { payments, Psbt } from 'bitcoinjs-lib';

const bip32 = BIP32Factory(ecc);

export class WalletHelper {
    private mnemonic: string;
    private seed: Buffer;
    private root: any;

    constructor(mnemonic: string = 'test test test test test test test test test test test test') {
        this.mnemonic = mnemonic;
        this.seed = mnemonicToSeedSync(this.mnemonic);
        this.root = bip32.fromSeed(this.seed);
    }

    getMnemonic(): string {
        return this.mnemonic;
    }

    generateAddresses(count: number, type: 'p2wpkh' | 'p2wsh' | 'p2tr'): string[] {
        const addresses: string[] = [];
        for (let i = 0; i < count; i++) {
            const path = `m/84'/0'/0'/0/${i}`;
            const child = this.root.derivePath(path);
            let address: string;

            switch (type) {
                case 'p2wpkh':
                    address = payments.p2wpkh({ pubkey: child.publicKey }).address!;
                    break;
                case 'p2wsh':
                    address = payments.p2wsh({
                        redeem: payments.p2ms({ m: 2, pubkeys: [child.publicKey, randomBytes(33)] }),
                    }).address!;
                    break;
                case 'p2tr':
                    address = payments.p2tr({
                        internalPubkey: child.publicKey.slice(1, 33),
                    }).address!;
                    break;
                default:
                    throw new Error('Unsupported address type');
            }

            addresses.push(address);
        }
        return addresses;
    }

    createWallet(): { mnemonic: string; addresses: string[] } {
        const addresses = this.generateAddresses(10, 'p2wpkh');
        return { mnemonic: this.mnemonic, addresses };
    }

    /**
     * Craft and sign a transaction sending 6 BTC to the provided Taproot address.
     *
     * @param utxos - Array of UTXOs to spend from.
     * @param taprootAddress - The Taproot address to send to.
     * @param fee - The fee to apply in satoshis.
     * @returns {string} The raw signed transaction hex.
     */
    craftTransaction(
        utxos: Array<{ txid: string; vout: number; value: number; rawTx: string }>,
        taprootAddress: string
    ): string {
        const psbt = new Psbt();

        utxos.forEach((utxo, index) => {
            psbt.addInput({
                hash: utxo.txid,
                index: utxo.vout,
                nonWitnessUtxo: Buffer.from(utxo.rawTx, 'hex'),
            });
        });

        // Add the output to the Taproot address (6 BTC)
        const totalInputValue = utxos.reduce((acc, utxo) => acc + utxo.value, 0);
        const outputValue = 6 * 1e8; 
        const fee = 1 * 1e8; 

        if (totalInputValue < outputValue + fee) {
            throw new Error('Insufficient funds');
        }

        psbt.addOutput({
            address: taprootAddress,
            value: BigInt(outputValue), 
        });

        // Sign the inputs with the corresponding private keys
        utxos.forEach((utxo, index) => {
            const child = this.root.derivePath(`m/84'/0'/0'/0/${index}`);
            const keyPair = child;
            psbt.signInput(index, keyPair);
        });

        psbt.finalizeAllInputs();

        const rawTx = psbt.extractTransaction().toHex();
        return rawTx;
    }
}
