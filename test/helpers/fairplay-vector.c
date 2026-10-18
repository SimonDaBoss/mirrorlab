/* Offline fixture generator. Link against UxPlay's GPL PlayFair sources.
 * gcc -Iwork/UxPlay/lib/playfair test/helpers/fairplay-vector.c work/UxPlay/lib/playfair/*.c -o work/fairplay-vector.exe
 * The synthetic challenge and wrapped key are for tests only, never production.
 */
#include <stdio.h>
#include <string.h>
#include "playfair.h"
int main(void) {
    unsigned char handshake[164], wrapped[72], key[16];
    memset(handshake, 0x42, sizeof(handshake));
    memcpy(handshake, "FPLY", 4);
    handshake[4] = 3;
    handshake[12] = 0;
    memset(wrapped, 0x21, sizeof(wrapped));
    playfair_decrypt(handshake, wrapped, key);
    for (int i = 0; i < 16; i++) printf("%02x", key[i]);
    puts("");
    return 0;
}
