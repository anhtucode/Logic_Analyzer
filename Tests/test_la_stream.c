#include <assert.h>
#include <stdint.h>
#include <stdio.h>

#include "la_stream.h"

int main(void)
{
  static la_sample_t block[LA_STREAM_BLOCK_SAMPLE_COUNT];
  const la_stream_block_t *pending;
  uint16_t index;

  for (index = 0U; index < LA_STREAM_BLOCK_SAMPLE_COUNT; index++)
  {
    block[index] = (la_sample_t)index;
  }

  LA_StreamInit();
  assert(!LA_StreamIsRunning());
  assert(!LA_StreamStart(2000U));
  assert(LA_StreamStart(10000U));
  assert(LA_StreamIsRunning());

  assert(LA_StreamProcessSamples(block, LA_STREAM_BLOCK_SAMPLE_COUNT));
  pending = LA_StreamPeekBlock();
  assert(pending != 0);
  assert(pending->stream_id == 1U);
  assert(pending->first_sample_index == 0U);
  assert(pending->sample_rate_hz == 10000U);
  assert(pending->sample_count == LA_STREAM_BLOCK_SAMPLE_COUNT);
  assert(pending->dropped_blocks == 0U);
  assert(pending->samples[255] == 255U);

  /* A second DMA half arriving before consumption is counted as dropped. */
  assert(LA_StreamProcessSamples(block, LA_STREAM_BLOCK_SAMPLE_COUNT));
  LA_StreamConsumeBlock();
  assert(LA_StreamPeekBlock() == 0);

  assert(LA_StreamProcessSamples(block, LA_STREAM_BLOCK_SAMPLE_COUNT));
  pending = LA_StreamPeekBlock();
  assert(pending != 0);
  assert(pending->first_sample_index ==
         (uint32_t)(2U * LA_STREAM_BLOCK_SAMPLE_COUNT));
  assert(pending->dropped_blocks == 1U);

  LA_StreamStop();
  assert(!LA_StreamIsRunning());
  assert(LA_StreamPeekBlock() == 0);
  puts("la stream tests passed");
  return 0;
}
