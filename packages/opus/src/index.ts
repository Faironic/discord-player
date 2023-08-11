// based on https://github.com/amishshah/prism-media/blob/4ef1d6f9f53042c085c1f68627e889003e248d77/src/opus/Opus.js

import { Transform } from 'stream';

export type IEncoder = {
    new (rate: number, channels: number, application: number): {
        encode(buffer: Buffer): Buffer;
        encode(buffer: Buffer, frameSize: number): Buffer;
        encode(buffer: Buffer, frameSize?: number): Buffer;
        decode(buffer: Buffer): Buffer;
        decode(buffer: Buffer, frameSize: number): Buffer;
        decode(buffer: Buffer, frameSize?: number): Buffer;
        applyEncoderCTL?(ctl: number, value: number): void;
        encoderCTL?(ctl: number, value: number): void;
        delete?(): void;
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    Application?: any;
};

type IMod = [
    string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mod: any) => {
        Encoder: IEncoder;
    }
];

const loadModule = (
    modules: IMod[]
): {
    Encoder: IEncoder;
    name: string;
} => {
    const errors: string[] = [];

    for (const [name, fn] of modules) {
        try {
            return {
                // eslint-disable-next-line @typescript-eslint/no-var-requires
                ...fn(require(name)),
                name
            };
        } catch (e) {
            errors.push(`Failed to load ${name}: ${e}`);
            continue;
        }
    }

    throw new Error(`Could not load opus module, tried ${modules.length} different modules. Errors: ${errors.join('\n')}`);
};

export const CTL = {
    BITRATE: 0xfa2,
    FEC: 0xfac,
    PLP: 0xfae
} as const;

export const OPUS_MOD_REGISTRY: IMod[] = [
    [
        'mediaplex',
        (mod) => {
            if (!mod.OpusEncoder) throw new Error('Unsupported mediaplex version');
            return { Encoder: mod.OpusEncoder };
        }
    ],
    ['@discordjs/opus', (opus) => ({ Encoder: opus.OpusEncoder })],
    ['node-opus', (opus) => ({ Encoder: opus.OpusEncoder })],
    ['opusscript', (opus) => ({ Encoder: opus })]
];

let Opus: { Encoder?: IEncoder; name?: string } = {};

function loadOpus(refresh = false) {
    if (Opus.Encoder && !refresh) return Opus;

    Opus = loadModule(OPUS_MOD_REGISTRY);
    return Opus;
}

const charCode = (x: string) => x.charCodeAt(0);
const OPUS_HEAD = Buffer.from([...'OpusHead'].map(charCode));
const OPUS_TAGS = Buffer.from([...'OpusTags'].map(charCode));

export interface IOpusStreamInit {
    frameSize: number;
    channels: number;
    rate: number;
    application?: number;
}

// frame size = (channels * rate * frame_duration) / 1000

/**
 * Takes a stream of Opus data and outputs a stream of PCM data, or the inverse.
 * **You shouldn't directly instantiate this class, see opus.Encoder and opus.Decoder instead!**
 * @memberof opus
 * @extends TransformStream
 * @protected
 */
export class OpusStream extends Transform {
    public encoder: InstanceType<IEncoder> | null = null;
    public _options: IOpusStreamInit;
    public _required: number;
    /**
     * Creates a new Opus transformer.
     * @private
     * @memberof opus
     * @param {Object} [options] options that you would pass to a regular Transform stream
     */
    constructor(options = {} as IOpusStreamInit) {
        if (!loadOpus().Encoder) {
            throw Error(`Could not find an Opus module! Please install one of ${OPUS_MOD_REGISTRY.map((o) => o[0]).join(', ')}.`);
        }
        super(Object.assign({ readableObjectMode: true }, options));

        const lib = Opus as Required<typeof Opus>;

        if (lib.name === 'opusscript') {
            options.application = lib.Encoder.Application![options.application!];
        }

        this.encoder = new lib.Encoder(options.rate, options.channels, options.application!);

        this._options = options;
        this._required = this._options.frameSize * this._options.channels * 2;
    }

    _encode(buffer: Buffer) {
        if (Opus.name === 'opusscript') {
            return this.encoder!.encode(buffer, this._options.frameSize);
        } else {
            return this.encoder!.encode(buffer);
        }
    }

    _decode(buffer: Buffer) {
        if (Opus.name === 'opusscript') {
            return this.encoder!.decode(buffer, this._options.frameSize);
        } else {
            return this.encoder!.decode(buffer);
        }
    }

    /**
     * Returns the Opus module being used - `opusscript`, `node-opus`, or `@discordjs/opus`.
     * @type {string}
     * @readonly
     * @example
     * console.log(`Using Opus module ${prism.opus.Encoder.type}`);
     */
    static get type() {
        return Opus.name;
    }

    /**
     * Sets the bitrate of the stream.
     * @param {number} bitrate the bitrate to use use, e.g. 48000
     * @public
     */
    setBitrate(bitrate: number) {
        (this.encoder!.applyEncoderCTL! || this.encoder!.encoderCTL).apply(this.encoder!, [CTL.BITRATE, Math.min(128e3, Math.max(16e3, bitrate))]);
    }

    /**
     * Enables or disables forward error correction.
     * @param {boolean} enabled whether or not to enable FEC.
     * @public
     */
    setFEC(enabled: boolean) {
        (this.encoder!.applyEncoderCTL! || this.encoder!.encoderCTL).apply(this.encoder!, [CTL.FEC, enabled ? 1 : 0]);
    }

    /**
     * Sets the expected packet loss over network transmission.
     * @param {number} [percentage] a percentage (represented between 0 and 1)
     */
    setPLP(percentage: number) {
        (this.encoder!.applyEncoderCTL! || this.encoder!.encoderCTL).apply(this.encoder!, [CTL.PLP, Math.min(100, Math.max(0, percentage * 100))]);
    }

    _final(cb: () => void) {
        this._cleanup();
        cb();
    }

    _destroy(err: Error | null, cb: (err: Error | null) => void) {
        this._cleanup();
        return cb ? cb(err) : undefined;
    }

    /**
     * Cleans up the Opus stream when it is no longer needed
     * @private
     */
    _cleanup() {
        if (Opus.name === 'opusscript' && this.encoder!) this.encoder!.delete!();
        this.encoder = null;
    }
}

/**
 * An Opus encoder stream.
 *
 * Outputs opus packets in [object mode.](https://nodejs.org/api/stream.html#stream_object_mode)
 * @extends opus.OpusStream
 * @memberof opus
 * @example
 * const encoder = new prism.opus.Encoder({ frameSize: 960, channels: 2, rate: 48000 });
 * pcmAudio.pipe(encoder);
 * // encoder will now output Opus-encoded audio packets
 */
export class OpusEncoder extends OpusStream {
    _buffer: Buffer | null = Buffer.alloc(0);

    /**
     * Creates a new Opus encoder stream.
     * @memberof opus
     * @param {Object} options options that you would pass to a regular OpusStream, plus a few more:
     * @param {number} options.frameSize the frame size in bytes to use (e.g. 960 for stereo audio at 48KHz with a frame
     * duration of 20ms)
     * @param {number} options.channels the number of channels to use
     * @param {number} options.rate the sampling rate in Hz
     */
    constructor(options = {} as IOpusStreamInit) {
        super(options);
    }

    _transform(chunk: Buffer, encoding: BufferEncoding, done: () => void) {
        this._buffer = Buffer.concat([this._buffer!, chunk]);
        let n = 0;
        while (this._buffer.length >= this._required * (n + 1)) {
            const buf = this._encode(this._buffer.slice(n * this._required, (n + 1) * this._required));
            this.push(buf);
            n++;
        }
        if (n > 0) this._buffer = this._buffer.slice(n * this._required);
        return done();
    }

    _destroy(err: Error, cb: (err: Error | null) => void) {
        super._destroy(err, cb);
        this._buffer = null;
    }
}

/**
 * An Opus decoder stream.
 *
 * Note that any stream you pipe into this must be in
 * [object mode](https://nodejs.org/api/stream.html#stream_object_mode) and should output Opus packets.
 * @extends opus.OpusStream
 * @memberof opus
 * @example
 * const decoder = new prism.opus.Decoder({ frameSize: 960, channels: 2, rate: 48000 });
 * input.pipe(decoder);
 * // decoder will now output PCM audio
 */
export class OpusDecoder extends OpusStream {
    _transform(chunk: Buffer, encoding: BufferEncoding, done: (e?: Error | null, chunk?: Buffer) => void) {
        const signature = chunk.slice(0, 8);
        if (chunk.length >= 8 && signature.equals(OPUS_HEAD)) {
            this.emit('format', {
                channels: this._options.channels,
                sampleRate: this._options.rate,
                bitDepth: 16,
                float: false,
                signed: true,
                version: chunk.readUInt8(8),
                preSkip: chunk.readUInt16LE(10),
                gain: chunk.readUInt16LE(16)
            });
            return done();
        }
        if (chunk.length >= 8 && signature.equals(OPUS_TAGS)) {
            this.emit('tags', chunk);
            return done();
        }
        try {
            this.push(this._decode(chunk));
        } catch (e) {
            return done(e as Error);
        }
        return done();
    }
}

// eslint-disable-next-line @typescript-eslint/no-inferrable-types
export const version: string = '[VI]{{inject}}[/VI]';
