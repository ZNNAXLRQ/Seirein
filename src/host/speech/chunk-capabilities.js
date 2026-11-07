/** chunk-capabilities — extracted from index.js; no host entry dependency. */
import * as ttsModule from './tts.js';

/** P-65: chunking seams, or null when a test stub replaced `tts.js` with a pre-chunking double. */
const chunkCuts = typeof ttsModule.speechChunkTexts === 'function' ? ttsModule.speechChunkTexts : null;

const chunkPlayer = typeof ttsModule.speakChunks === 'function' ? ttsModule.speakChunks : null;

const chunkClamp = typeof ttsModule.resolveChunkMinChars === 'function' ? ttsModule.resolveChunkMinChars : null;

export { chunkCuts, chunkPlayer, chunkClamp };
