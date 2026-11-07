#include <assert.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>

#include "la_acquisition.h"
#include "la_controller.h"

static la_acquisition_block_callback_t fake_block_callback;
static la_acquisition_error_callback_t fake_error_callback;
static bool fake_running;
static uint32_t fake_tick;

uint32_t HAL_GetTick(void)
{
  return fake_tick;
}

bool LA_AcquisitionInit(TIM_HandleTypeDef *timer, DMA_HandleTypeDef *dma)
{
  (void)timer;
  (void)dma;
  return true;
}

void LA_AcquisitionSetCallbacks(
    la_acquisition_block_callback_t block_callback,
    la_acquisition_error_callback_t error_callback)
{
  fake_block_callback = block_callback;
  fake_error_callback = error_callback;
}

bool LA_AcquisitionStart(uint32_t sample_rate_hz)
{
  (void)sample_rate_hz;
  fake_running = true;
  return true;
}

void LA_AcquisitionStop(void)
{
  fake_running = false;
}

void LA_AcquisitionProcessPendingBlocks(void)
{
}

bool LA_AcquisitionIsRunning(void)
{
  return fake_running;
}

static void FakeFeed(la_sample_t sample, uint16_t count)
{
  la_sample_t block[LA_DMA_HALF_SAMPLE_COUNT];
  uint16_t index;

  for (index = 0U; index < LA_DMA_HALF_SAMPLE_COUNT; index++)
  {
    block[index] = sample;
  }

  while ((count != 0U) && fake_running)
  {
    uint16_t block_count = (count > LA_DMA_HALF_SAMPLE_COUNT)
        ? LA_DMA_HALF_SAMPLE_COUNT
        : count;

    if (!fake_block_callback(block, block_count))
    {
      fake_running = false;
    }
    count -= block_count;
  }
}

static la_config_t MakeConfig(void)
{
  la_config_t config;

  config.sample_rate_hz = 1000000U;
  config.channel_mask = LA_CHANNEL_MASK_ALL;
  config.trigger_channel = 0U;
  config.trigger_edge = TRIG_RISING;
  config.pretrigger_pct = 50U;
  config.timeout_ms = 100U;
  return config;
}

static void TestDispatcherRevisionAndBusyRules(void)
{
  la_config_t config = MakeConfig();
  control_request_t request;

  assert(LA_Init(&config));
  assert(LA_GetConfigRevision() == 1U);

  request.action = CTRL_SET_CONFIG;
  request.source = SOURCE_PC;
  request.config = config;
  request.expected_revision = 0U;
  assert(LA_DispatchControl(&request) == CONTROL_REVISION_CONFLICT);

  request.expected_revision = 1U;
  request.config.trigger_channel = 1U;
  assert(LA_DispatchControl(&request) == CONTROL_ACK);
  assert(LA_GetConfigRevision() == 2U);

  assert(LA_Arm() == CONTROL_ACK);
  assert(LA_GetState() == LA_PRE_FILL);
  assert(LA_SetConfig(&config) == CONTROL_BUSY);
  assert(LA_Stop() == CONTROL_ACK);
  assert(LA_GetState() == LA_IDLE);
}

static void TestCaptureOwnershipAndRearm(void)
{
  la_config_t config = MakeConfig();
  const capture_result_t *result;

  config.trigger_channel = 0U;
  assert(LA_Init(&config));
  assert(LA_Arm() == CONTROL_ACK);

  FakeFeed(0x0000U, LA_CAPTURE_SAMPLE_COUNT / 2U);
  assert(LA_GetState() == LA_ARMED);
  FakeFeed(0x0001U, 1U);
  FakeFeed(0x0001U, (LA_CAPTURE_SAMPLE_COUNT / 2U) - 1U);
  assert(LA_GetState() == LA_COMPLETE);
  assert(!fake_running);

  result = LA_LockCapture(LA_CAPTURE_OWNER_PC);
  assert(result != 0);
  assert(result->trigger_index == LA_CAPTURE_SAMPLE_COUNT / 2U);
  assert(LA_Rearm() == CONTROL_BUSY);

  LA_ReleaseCapture(LA_CAPTURE_OWNER_PC);
  assert(LA_Rearm() == CONTROL_ACK);
  assert(LA_GetState() == LA_PRE_FILL);
  assert(fake_running);
  assert(LA_Stop() == CONTROL_ACK);
}

static void TestSetConfigAfterComplete(void)
{
  la_config_t config = MakeConfig();
  la_config_t updated = config;
  const capture_result_t *result;

  assert(LA_Init(&config));
  assert(LA_Arm() == CONTROL_ACK);

  FakeFeed(0x0000U, LA_CAPTURE_SAMPLE_COUNT / 2U);
  FakeFeed(0x0001U, 1U);
  FakeFeed(0x0001U, (LA_CAPTURE_SAMPLE_COUNT / 2U) - 1U);
  assert(LA_GetState() == LA_COMPLETE);

  result = LA_LockCapture(LA_CAPTURE_OWNER_PC);
  assert(result != 0);
  updated.sample_rate_hz = 100000U;
  assert(LA_SetConfig(&updated) == CONTROL_BUSY);
  assert(LA_GetState() == LA_COMPLETE);

  LA_ReleaseCapture(LA_CAPTURE_OWNER_PC);
  assert(LA_SetConfig(&updated) == CONTROL_ACK);
  assert(LA_GetState() == LA_IDLE);
  assert(LA_GetCaptureResult() == 0);
  assert(LA_GetConfig()->sample_rate_hz == 100000U);
  assert(LA_GetConfigRevision() == 2U);
}

static void TestTimeoutStartsAfterPrefill(void)
{
  la_config_t config = MakeConfig();
  la_config_t updated;

  fake_tick = 500U;
  assert(LA_Init(&config));
  assert(LA_Arm() == CONTROL_ACK);

  fake_tick = 1000U;
  LA_ProcessPendingBlocks();
  assert(LA_GetState() == LA_PRE_FILL);

  FakeFeed(0x0000U, LA_CAPTURE_SAMPLE_COUNT / 2U);
  assert(LA_GetState() == LA_ARMED);

  fake_tick += 99U;
  LA_ProcessPendingBlocks();
  assert(LA_GetState() == LA_ARMED);

  fake_tick += 1U;
  LA_ProcessPendingBlocks();
  assert(LA_GetState() == LA_TIMEOUT);
  assert(!fake_running);

  updated = config;
  updated.sample_rate_hz = 100000U;
  assert(LA_SetConfig(&updated) == CONTROL_ACK);
  assert(LA_GetState() == LA_IDLE);
  assert(LA_GetConfig()->sample_rate_hz == 100000U);
}

static void TestStreamingControlRules(void)
{
  la_config_t config = MakeConfig();

  assert(LA_Init(&config));
  assert(LA_StartStream(2000U) == CONTROL_INVALID);
  assert(LA_StartStream(5000U) == CONTROL_ACK);
  assert(LA_GetState() == LA_STREAMING);
  assert(fake_running);
  assert(LA_SetConfig(&config) == CONTROL_BUSY);
  assert(LA_Arm() == CONTROL_BUSY);
  assert(LA_Rearm() == CONTROL_BUSY);

  FakeFeed(0xA5U, LA_DMA_HALF_SAMPLE_COUNT);
  assert(LA_GetState() == LA_STREAMING);
  assert(LA_StopStream() == CONTROL_ACK);
  assert(LA_GetState() == LA_IDLE);
  assert(!fake_running);
}

int main(void)
{
  assert(fake_error_callback == 0);
  TestDispatcherRevisionAndBusyRules();
  TestCaptureOwnershipAndRearm();
  TestSetConfigAfterComplete();
  TestTimeoutStartsAfterPrefill();
  TestStreamingControlRules();
  puts("la controller tests passed");
  return 0;
}
