/* Synthetic 44.1 kHz stereo AAC-ELD fixture, generated with libfdk-aac.
 * gcc test/helpers/generate-aac-eld.c -lfdk-aac -lm -o work/generate-aac-eld.exe
 * work/generate-aac-eld.exe test/fixtures/tone-aac-eld.bin
 * Output: repeated 4-byte big-endian packet length and one raw AAC-ELD frame.
 */
#include <stdio.h>
#include <math.h>
#include <fdk-aac/aacenc_lib.h>
int main(int argc, char **argv) {
    HANDLE_AACENCODER enc = NULL;
    if (argc != 2 || aacEncOpen(&enc, 0, 2) != AACENC_OK) return 1;
    if (aacEncoder_SetParam(enc, AACENC_AOT, AOT_ER_AAC_ELD) != AACENC_OK ||
        aacEncoder_SetParam(enc, AACENC_SAMPLERATE, 44100) != AACENC_OK ||
        aacEncoder_SetParam(enc, AACENC_CHANNELMODE, MODE_2) != AACENC_OK ||
        aacEncoder_SetParam(enc, AACENC_BITRATE, 128000) != AACENC_OK ||
        aacEncoder_SetParam(enc, AACENC_TRANSMUX, TT_MP4_RAW) != AACENC_OK ||
        aacEncoder_SetParam(enc, AACENC_GRANULE_LENGTH, 480) != AACENC_OK ||
        aacEncEncode(enc, NULL, NULL, NULL, NULL) != AACENC_OK) return 2;
    FILE *file = fopen(argv[1], "wb");
    if (!file) return 3;
    short samples[960];
    unsigned char packet[4096];
    int inId = IN_AUDIO_DATA, outId = OUT_BITSTREAM_DATA;
    int inSize = sizeof(samples), outSize = sizeof(packet), inElem = sizeof(short), outElem = 1;
    void *input = samples, *output = packet;
    AACENC_BufDesc in = {1, &input, &inId, &inSize, &inElem};
    AACENC_BufDesc out = {1, &output, &outId, &outSize, &outElem};
    for (int frame = 0; frame < 120; frame++) {
        for (int i = 0; i < 480; i++) samples[i * 2] = samples[i * 2 + 1] = (short)(6000 * sin((frame * 480 + i) * 440 * 6.283185307 / 44100));
        AACENC_InArgs args = {960, 0};
        AACENC_OutArgs result = {0};
        if (aacEncEncode(enc, &in, &out, &args, &result) != AACENC_OK) return 4;
        if (result.numOutBytes) {
            unsigned int n = result.numOutBytes;
            unsigned char size[] = {n >> 24, n >> 16, n >> 8, n};
            fwrite(size, 1, 4, file);
            fwrite(packet, 1, n, file);
        }
    }
    fclose(file);
    aacEncClose(&enc);
    return 0;
}
