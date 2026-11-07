#include <assert.h>
#include <stdint.h>
#include <stdio.h>

#include "la_buffer.h"
#include "la_trigger.h"

static void TestBufferRejectsInvalidArguments(void)
{
  la_circular_buffer_t buffer;
  la_sample_t storage[4];

  assert(!LA_BufferInit(0, storage, 4U));
  assert(!LA_BufferInit(&buffer, 0, 4U));
  assert(!LA_BufferInit(&buffer, storage, 0U));
}

static void TestBufferPreservesChronologicalOrder(void)
{
  la_circular_buffer_t buffer;
  la_sample_t storage[4];
  la_sample_t sample;
  uint16_t index;

  assert(LA_BufferInit(&buffer, storage, 4U));
  for (index = 1U; index <= 6U; index++)
  {
    (void)LA_BufferPush(&buffer, index);
  }

  assert(buffer.count == 4U);
  assert(LA_BufferGetOldestIndex(&buffer) == 2U);

  for (index = 0U; index < 4U; index++)
  {
    assert(LA_BufferReadChronological(&buffer, index, &sample));
    assert(sample == (la_sample_t)(index + 3U));
  }

  assert(!LA_BufferReadChronological(&buffer, 4U, &sample));
}

static void TestCaptureSizedBufferWrapsWithoutCopy(void)
{
  static la_sample_t storage[LA_CAPTURE_SAMPLE_COUNT];
  la_circular_buffer_t buffer;
  la_sample_t sample;
  uint16_t index;

  assert(LA_BufferInit(&buffer, storage, LA_CAPTURE_SAMPLE_COUNT));
  for (index = 0U; index < LA_CAPTURE_SAMPLE_COUNT; index++)
  {
    (void)LA_BufferPush(&buffer, (la_sample_t)index);
  }

  (void)LA_BufferPush(&buffer, 0xA5U);
  assert(buffer.count == LA_CAPTURE_SAMPLE_COUNT);
  assert(LA_BufferGetOldestIndex(&buffer) == 1U);
  assert(LA_BufferReadChronological(&buffer, 0U, &sample));
  assert(sample == 1U);
  assert(LA_BufferReadChronological(&buffer,
                                    LA_CAPTURE_SAMPLE_COUNT - 1U,
                                    &sample));
  assert(sample == 0xA5U);
}

static void TestTriggerDetectsEdgesAcrossCalls(void)
{
  la_trigger_t trigger;

  assert(LA_TriggerInit(&trigger, 3U, TRIG_RISING));
  assert(!LA_TriggerProcessSample(&trigger, 0x0000U));
  assert(!LA_TriggerProcessSample(&trigger, 0x0000U));
  assert(LA_TriggerProcessSample(&trigger, 0x0008U));
  assert(!LA_TriggerProcessSample(&trigger, 0x0008U));

  assert(LA_TriggerConfigure(&trigger, 3U, TRIG_FALLING));
  assert(!LA_TriggerProcessSample(&trigger, 0x0008U));
  assert(LA_TriggerProcessSample(&trigger, 0x0000U));
  assert(!LA_TriggerProcessSample(&trigger, 0x0000U));
}

static void TestTriggerAtDmaHalfBoundary(void)
{
  la_trigger_t trigger;
  uint16_t index;

  assert(LA_TriggerInit(&trigger, 0U, TRIG_RISING));

  for (index = 0U; index < LA_DMA_HALF_SAMPLE_COUNT; index++)
  {
    assert(!LA_TriggerProcessSample(&trigger, 0x0000U));
  }

  /* First sample in the second DMA half is the first high level. */
  assert(LA_TriggerProcessSample(&trigger, 0x0001U));
}

static void TestTriggerRejectsInvalidConfiguration(void)
{
  la_trigger_t trigger;

  assert(!LA_TriggerInit(&trigger, LA_CHANNEL_COUNT, TRIG_RISING));
  assert(!LA_TriggerInit(&trigger, 0U, (trigger_edge_t)2));
}

int main(void)
{
  TestBufferRejectsInvalidArguments();
  TestBufferPreservesChronologicalOrder();
  TestCaptureSizedBufferWrapsWithoutCopy();
  TestTriggerDetectsEdgesAcrossCalls();
  TestTriggerAtDmaHalfBoundary();
  TestTriggerRejectsInvalidConfiguration();
  puts("la core tests passed");
  return 0;
}
