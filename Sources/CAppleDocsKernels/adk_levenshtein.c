//
//  adk_levenshtein.c
//  CAppleDocsKernels
//
//  Myers (1999) 64-bit bit-parallel edit-distance kernel over UTF-16 code units with bounded
//  `max_dist` early exit, plus banded dynamic-programming fallback for patterns longer than 64 UTF-16
//  units. Computes the exact Levenshtein distance when `<= max_dist` and returns `max_dist + 1`
//  otherwise.
//

#include "CAppleDocsKernels.h"

#include <stdlib.h>
#include <string.h>

static int32_t adk_levenshtein_dp_fallback(
    const uint16_t *lhs,
    size_t lhs_len,
    const uint16_t *rhs,
    size_t rhs_len,
    int32_t max_dist) {
    size_t width = rhs_len + 1;
    int32_t stack_buf[514];
    int32_t *buf = (width * 2 <= 514) ? stack_buf : (int32_t *)malloc(width * 2 * sizeof(int32_t));
    if (!buf) return max_dist + 1;
    int32_t *prev = buf;
    int32_t *curr = buf + width;
    for (size_t j = 0; j <= rhs_len; ++j) {
        prev[j] = (int32_t)j;
    }
    for (size_t i = 1; i <= lhs_len; ++i) {
        curr[0] = (int32_t)i;
        int32_t row_min = (int32_t)i;
        uint16_t ca = lhs[i - 1];
        for (size_t j = 1; j <= rhs_len; ++j) {
            int32_t cost = (ca == rhs[j - 1]) ? prev[j - 1] : (prev[j - 1] + 1);
            int32_t del = prev[j] + 1;
            int32_t ins = curr[j - 1] + 1;
            int32_t v = cost < del ? cost : del;
            if (ins < v) v = ins;
            curr[j] = v;
            if (v < row_min) row_min = v;
        }
        if (row_min > max_dist) {
            if (buf != stack_buf) free(buf);
            return max_dist + 1;
        }
        int32_t *tmp = prev;
        prev = curr;
        curr = tmp;
    }
    int32_t ans = prev[rhs_len];
    if (buf != stack_buf) free(buf);
    return (ans <= max_dist) ? ans : (max_dist + 1);
}

int32_t adk_levenshtein_u16(
    const uint16_t *lhs,
    size_t lhs_len,
    const uint16_t *rhs,
    size_t rhs_len,
    int32_t max_dist) {
    if (max_dist < 0) return 1;
    size_t diff = (lhs_len > rhs_len) ? (lhs_len - rhs_len) : (rhs_len - lhs_len);
    if (diff > (size_t)max_dist) {
        return max_dist + 1;
    }
    // Put shorter string in `lhs` so Myers bit-parallel fits up to min(lhs_len, rhs_len) <= 64.
    if (lhs_len > rhs_len) {
        const uint16_t *tmp_p = lhs;
        lhs = rhs;
        rhs = tmp_p;
        size_t tmp_l = lhs_len;
        lhs_len = rhs_len;
        rhs_len = tmp_l;
    }
    if (lhs_len == 0) {
        return (rhs_len <= (size_t)max_dist) ? (int32_t)rhs_len : (max_dist + 1);
    }
    if (lhs_len > 64) {
        return adk_levenshtein_dp_fallback(lhs, lhs_len, rhs, rhs_len, max_dist);
    }

    // Build Peq masks: ASCII fast table (128 entries on stack) + compact overflow list for non-ASCII units.
    uint64_t ascii_eq[128];
    memset(ascii_eq, 0, sizeof(ascii_eq));
    uint16_t extra_chars[64];
    uint64_t extra_masks[64];
    size_t extra_count = 0;

    for (size_t i = 0; i < lhs_len; ++i) {
        uint16_t ch = lhs[i];
        uint64_t bit = 1ULL << i;
        if (ch < 128) {
            ascii_eq[ch] |= bit;
        } else {
            size_t found = extra_count;
            for (size_t k = 0; k < extra_count; ++k) {
                if (extra_chars[k] == ch) {
                    found = k;
                    break;
                }
            }
            if (found == extra_count) {
                extra_chars[extra_count] = ch;
                extra_masks[extra_count] = bit;
                extra_count++;
            } else {
                extra_masks[found] |= bit;
            }
        }
    }

    uint64_t pv = ~0ULL;
    uint64_t mv = 0ULL;
    int32_t score = (int32_t)lhs_len;
    const uint64_t high_bit = 1ULL << (lhs_len - 1);

    for (size_t j = 0; j < rhs_len; ++j) {
        uint16_t ch = rhs[j];
        uint64_t eq = 0ULL;
        if (ch < 128) {
            eq = ascii_eq[ch];
        } else {
            for (size_t k = 0; k < extra_count; ++k) {
                if (extra_chars[k] == ch) {
                    eq = extra_masks[k];
                    break;
                }
            }
        }

        uint64_t xv = eq | mv;
        uint64_t xh = (((eq & pv) + pv) ^ pv) | eq;

        uint64_t ph = mv | ~(xh | pv);
        uint64_t mh = pv & xh;

        if ((ph & high_bit) != 0) {
            score += 1;
        } else if ((mh & high_bit) != 0) {
            score -= 1;
        }

        // Lower bound on final distance from column `j`: `score - (rhs_len - 1 - j)`.
        size_t remaining = rhs_len - 1 - j;
        if (score - (int32_t)remaining > max_dist) {
            return max_dist + 1;
        }

        ph = (ph << 1) | 1ULL;
        mh = mh << 1;
        pv = mh | ~(xv | ph);
        mv = ph & xv;
    }

    return (score <= max_dist) ? score : (max_dist + 1);
}
