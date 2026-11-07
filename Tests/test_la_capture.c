#include <assert.h>
#include <stdint.h>
#include <stdio.h>

#include "la_capture.h"

static la_config_t MakeConfig(uint8_t pretrigger_pct,
                              trigger_edge_t edge)
{
  la_config_t config;

  config.sample_rate_hz = 1000000U;
  config.channel_mask = LA_CHANNEL_MASK_ALL;
  config.trigger_channel = 0U;
  config.trigger_edge = edge;
  config.pretrigger_pct = pretrigger_pct;
  config.timeout_ms = 1000U;
  return config;
}

static void FeedRepeated(la_capture_t *capture,
                         la_sample_t sample,
                         uint16_t count)
{
  la_sample_t block[LA_DMA_HALF_SAMPLE_COUNT];
  uint16_t index;

  for (index = 0U; index < LA_DMA_HALF_SAMPLE_COUNT; index++)
  {
    block[index] = sample;
  }

  while (count >= LA_DMA_HALF_SAMPLE_COUNT)
  {
    (void)LA_CaptureProcessSamples(capture,
                                   block,
                                   LA_DMA_HALF_SAMPLE_COUNT);
    count -= LA_DMA_HALF_SAMPLE_COUNT;
  }

  if (count != 0U)
  {
    (void)LA_CaptureProcessSamples(capture, block, count);
  }
}

static la_sample_t ReadResultSample(const capture_result_t *result,
                                    uint16_t index)
{
  uint16_t physical_index = result->start_offset + index;

  if (physical_index >= result->ring_capacity)
  {
    physical_index -= result->ring_capacity;
  }
  return result->ring[physical_index];
}

static void TestPrePostRatio(uint8_t pretrigger_pct)
{
  static la_sample_t ring[LA_CAPTURE_SAMPLE_COUNT];
  la_capture_t capture;
  la_config_t config = MakeConfig(pretrigger_pct, TRIG_RISING);
  const capture_result_t *result;
  uint16_t pre_samples = (uint16_t)
      ((LA_CAPTURE_SAMPLE_COUNT * pretrigger_pct) / 100U);
  uint16_t post_samples = LA_CAPTURE_SAMPLE_COUNT - pre_samples;

  assert(LA_CaptureInit(&capture,
                        &config,
                        ring,
                        LA_CAPTURE_SAMPLE_COUNT));
  assert(LA_CaptureArm(&capture));

  FeedRepeated(&capture, 0x00U, pre_samples);
  assert(capture.state == LA_ARMED);

  FeedRepeated(&capture, 0x01U, 1U);
  assert(capture.state == LA_POST_TRIGGER);
  FeedRepeated(&capture, 0x01U, post_samples - 1U);
  assert(capture.state == LA_COMPLETE);

  result = LA_CaptureGetResult(&capture);
  assert(result != 0);
  assert(result->sample_count == LA_CAPTURE_SAMPLE_COUNT);
  assert(result->trigger_index == pre_samples);
  assert(result->start_offset == 0U);
  assert(ReadResultSample(result, pre_samples - 1U) == 0x0000U);
  assert(ReadResultSample(result, pre_samples) == 0x0001U);
  assert(ReadResultSample(result, LA_CAPTURE_SAMPLE_COUNT - 1U) == 0x0001U);
}

static void TestRingWrapAndDmaBoundaryTrigger(void)
{
  static la_sample_t ring[LA_CAPTURE_SAMPLE_COUNT];
  la_capture_t capture;
  la_config_t config = MakeConfig(25U, TRIG_RISING);
  const capture_result_t *result;
  const uint16_t extra_wait_samples = LA_DMA_HALF_SAMPLE_COUNT;
  const uint16_t pre_samples = LA_CAPTURE_SAMPLE_COUNT / 4U;
  const uint16_t post_samples = LA_CAPTURE_SAMPLE_COUNT - pre_samples;

  assert(LA_CaptureInit(&capture,
                        &config,
                        ring,
                        LA_CAPTURE_SAMPLE_COUNT));
  assert(LA_CaptureArm(&capture));

  FeedRepeated(&capture, 0x0000U, pre_samples + extra_wait_samples);
  assert(capture.state == LA_ARMED);

  /* Trigger is the first sample in the next 128-sample DMA block. */
  FeedRepeated(&capture, 0x0001U, 1U);
  FeedRepeated(&capture, 0x0001U, post_samples - 1U);

  result = LA_CaptureGetResult(&capture);
  assert(result != 0);
  assert(result->start_offset == extra_wait_samples);
  assert(result->trigger_index == pre_samples);
  assert(ReadResultSample(result, pre_samples - 1U) == 0x0000U);
  assert(ReadResultSample(result, pre_samples) == 0x0001U);
}

static void TestFallingTriggerAndTimeoutState(void)
{
  static la_sample_t ring[LA_CAPTURE_SAMPLE_COUNT];
  la_capture_t capture;
  la_config_t config = MakeConfig(50U, TRIG_FALLING);

  assert(LA_CaptureInit(&capture,
                        &config,
                        ring,
                        LA_CAPTURE_SAMPLE_COUNT));
  assert(LA_CaptureArm(&capture));

  LA_CaptureSetTimeout(&capture);
  assert(capture.state == LA_PRE_FILL);

  FeedRepeated(&capture, 0x0001U, LA_CAPTURE_SAMPLE_COUNT / 2U);
  assert(capture.state == LA_ARMED);
  LA_CaptureSetTimeout(&capture);
  assert(capture.state == LA_TIMEOUT);
  assert(LA_CaptureGetResult(&capture) == 0);

  assert(LA_CaptureArm(&capture));
  FeedRepeated(&capture, 0x0001U, LA_CAPTURE_SAMPLE_COUNT / 2U);
  FeedRepeated(&capture, 0x0000U, 1U);
  assert(capture.state == LA_POST_TRIGGER);
}

static void TestInvalidConfiguration(void)
{
  la_config_t config = MakeConfig(50U, TRIG_RISING);

  assert(LA_CaptureConfigIsValid(&config));
  config.sample_rate_hz = 12345U;
  assert(!LA_CaptureConfigIsValid(&config));
  config = MakeConfig(50U, TRIG_RISING);
  config.timeout_ms = 99U;
  assert(!LA_CaptureConfigIsValid(&config));
  config = MakeConfig(40U, TRIG_RISING);
  assert(!LA_CaptureConfigIsValid(&config));
}

int main(void)
{
  TestPrePostRatio(25U);
  TestPrePostRatio(50U);
  TestPrePostRatio(75U);
  TestRingWrapAndDmaBoundaryTrigger();
  TestFallingTriggerAndTimeoutState();
  TestInvalidConfiguration();
  puts("la capture tests passed");
  return 0;
}
