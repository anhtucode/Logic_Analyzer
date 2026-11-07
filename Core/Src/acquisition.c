#include "acquisition.h"
#include <string.h>

#define LA_FLAG_OVERRUN  0x0001U
#define LA_FLAG_DMA      0x0002U

static TIM_HandleTypeDef *la_timer;
static DMA_HandleTypeDef *la_dma;
static uint8_t dma_buffer[LA_DMA_SAMPLES];
static uint8_t capture_buffer[LA_MAX_SAMPLES];

static LA_Config config;
static LA_Status status;
static volatile uint32_t produced_blocks;
static uint32_t processed_blocks;
static volatile bool dma_failed;
static bool dma_running;

static uint16_t write_index;
static uint16_t stored_samples;
static uint16_t capture_start;
static uint16_t pre_samples;
static uint16_t post_remaining;
static uint8_t previous_sample;
static bool previous_valid;
static uint32_t start_tick;

static bool stream_pending;
static uint8_t stream_half;
static uint32_t stream_id;
static uint32_t stream_first_sample;
static uint32_t next_stream_sample;

static bool RateIsValid(uint32_t rate)
{
  return (rate == 1000U) || (rate == 5000U) || (rate == 10000U) ||
         (rate == 50000U) || (rate == 100000U) ||
         (rate == 500000U) || (rate == 1000000U);
}

static bool DepthIsValid(uint16_t depth)
{
  return (depth == 1024U) || (depth == 2048U) ||
         (depth == 4096U) || (depth == 8192U);
}

static bool ConfigIsValid(const LA_Config *candidate)
{
  if ((candidate == NULL) || !RateIsValid(candidate->requested_rate_hz) ||
      !DepthIsValid(candidate->sample_depth) ||
      (candidate->mode > LA_MODE_STREAM) ||
      (candidate->trigger > LA_TRIGGER_FALLING) ||
      (candidate->trigger_channel > 7U) ||
      (candidate->pretrigger_percent > 90U))
  {
    return false;
  }

  /* USB Full Speed truyen 1 byte/mau: chi stream lien tuc toi da 10 kSa/s. */
  if ((candidate->mode == LA_MODE_STREAM) &&
      (candidate->requested_rate_hz > 10000U))
  {
    return false;
  }
  return true;
}

static uint32_t ConfigureTimer(uint32_t requested_rate)
{
  uint32_t timer_clock = HAL_RCC_GetPCLK1Freq();
  uint32_t divider;

  /* Timer APB1 duoc nhan doi clock khi prescaler APB1 khac 1. */
  if ((RCC->CFGR & RCC_CFGR_PPRE1) != 0U)
  {
    timer_clock *= 2U;
  }
  divider = (timer_clock + (requested_rate / 2U)) / requested_rate;

  if (divider == 0U)
  {
    divider = 1U;
  }

  __HAL_TIM_DISABLE(la_timer);
  __HAL_TIM_SET_PRESCALER(la_timer, 0U);
  __HAL_TIM_SET_AUTORELOAD(la_timer, divider - 1U);
  __HAL_TIM_SET_COUNTER(la_timer, 0U);
  la_timer->Instance->EGR = TIM_EGR_UG;
  __HAL_TIM_CLEAR_FLAG(la_timer, TIM_FLAG_UPDATE);
  return timer_clock / divider;
}

static void DmaHalfComplete(DMA_HandleTypeDef *unused)
{
  (void)unused;
  produced_blocks++;
}

static void DmaComplete(DMA_HandleTypeDef *unused)
{
  (void)unused;
  produced_blocks++;
}

static void DmaError(DMA_HandleTypeDef *unused)
{
  (void)unused;
  dma_failed = true;
}

static bool StartDma(void)
{
  la_dma->XferHalfCpltCallback = DmaHalfComplete;
  la_dma->XferCpltCallback = DmaComplete;
  la_dma->XferErrorCallback = DmaError;

  if (HAL_DMA_Start_IT(la_dma, (uint32_t)&GPIOA->IDR,
                       (uint32_t)dma_buffer, LA_DMA_SAMPLES) != HAL_OK)
  {
    return false;
  }

  __HAL_TIM_ENABLE_DMA(la_timer, TIM_DMA_UPDATE);
  if (HAL_TIM_Base_Start(la_timer) != HAL_OK)
  {
    __HAL_TIM_DISABLE_DMA(la_timer, TIM_DMA_UPDATE);
    (void)HAL_DMA_Abort(la_dma);
    return false;
  }
  dma_running = true;
  return true;
}

static void StopDma(void)
{
  if (dma_running)
  {
    __HAL_TIM_DISABLE_DMA(la_timer, TIM_DMA_UPDATE);
    (void)HAL_TIM_Base_Stop(la_timer);
    (void)HAL_DMA_Abort(la_dma);
    dma_running = false;
  }
}

static void FinishCapture(void)
{
  StopDma();
  status.valid_samples = config.sample_depth;
  status.capture_id++;
  status.state = LA_STATE_COMPLETE;
}

static void StoreSample(uint8_t sample)
{
  capture_buffer[write_index] = sample;
  /* Depth luon la luy thua cua 2, dung mask nhanh hon phep chia tren Cortex-M3. */
  write_index = (uint16_t)((write_index + 1U) & (config.sample_depth - 1U));
  if (stored_samples < config.sample_depth)
  {
    stored_samples++;
  }
}

static bool EdgeFound(uint8_t before, uint8_t now)
{
  uint8_t mask = (uint8_t)(1U << config.trigger_channel);
  bool old_level = (before & mask) != 0U;
  bool new_level = (now & mask) != 0U;

  if (config.trigger == LA_TRIGGER_RISING)
  {
    return !old_level && new_level;
  }
  return old_level && !new_level;
}

static void ProcessSnapshotBlock(const uint8_t *samples)
{
  uint16_t i;

  /* Trigger duoc quet o main loop; ISR chi bao nua DMA nao da hoan thanh. */
  for (i = 0U; (i < LA_STREAM_BLOCK_SAMPLES) && dma_running; i++)
  {
    uint8_t sample = samples[i];

    if (config.trigger == LA_TRIGGER_NONE)
    {
      StoreSample(sample);
      if (stored_samples == config.sample_depth)
      {
        capture_start = 0U;
        status.trigger_index = 0U;
        FinishCapture();
      }
      continue;
    }

    if (status.state == LA_STATE_ARMED)
    {
      StoreSample(sample);
      if (previous_valid && (stored_samples >= (uint16_t)(pre_samples + 1U)) &&
          EdgeFound(previous_sample, sample))
      {
        /* Mau hien tai la mau trigger va nam dung tai chi so pre_samples. */
        capture_start = (uint16_t)((write_index - (pre_samples + 1U)) &
                                   (config.sample_depth - 1U));
        status.trigger_index = pre_samples;
        post_remaining = (uint16_t)(config.sample_depth - pre_samples - 1U);
        status.state = LA_STATE_TRIGGERED;
        if (post_remaining == 0U)
        {
          FinishCapture();
        }
      }
      previous_sample = sample;
      previous_valid = true;
    }
    else if (status.state == LA_STATE_TRIGGERED)
    {
      StoreSample(sample);
      if (--post_remaining == 0U)
      {
        FinishCapture();
      }
    }
  }
}

static void ProcessStreamBlock(uint8_t half)
{
  /* Chi cho phep mot block dang cho PC; block moi den som la mat du lieu. */
  if (stream_pending)
  {
    status.flags |= LA_FLAG_OVERRUN;
    status.error = LA_ERROR_OVERRUN;
    status.dropped_blocks++;
    status.state = LA_STATE_ERROR;
    StopDma();
    return;
  }

  stream_half = half;
  stream_first_sample = next_stream_sample;
  next_stream_sample += LA_STREAM_BLOCK_SAMPLES;
  stream_pending = true;
}

void LA_Init(TIM_HandleTypeDef *timer, DMA_HandleTypeDef *dma)
{
  la_timer = timer;
  la_dma = dma;
  memset(&config, 0, sizeof(config));
  memset(&status, 0, sizeof(status));
  config.mode = LA_MODE_SNAPSHOT;
  config.trigger = LA_TRIGGER_RISING;
  config.trigger_channel = 0U;
  config.pretrigger_percent = 50U;
  config.sample_depth = 4096U;
  config.requested_rate_hz = 1000000U;
  config.actual_rate_hz = 1000000U;
  status.state = LA_STATE_IDLE;
  status.error = LA_ERROR_NONE;
  status.actual_rate_hz = config.actual_rate_hz;
}

bool LA_SetConfig(const LA_Config *new_config)
{
  if ((status.state == LA_STATE_ARMED) || (status.state == LA_STATE_TRIGGERED) ||
      (status.state == LA_STATE_STREAMING))
  {
    status.error = LA_ERROR_BUSY;
    return false;
  }
  if (!ConfigIsValid(new_config))
  {
    status.error = LA_ERROR_INVALID_CONFIG;
    return false;
  }

  config = *new_config;
  config.actual_rate_hz = ConfigureTimer(config.requested_rate_hz);
  status.actual_rate_hz = config.actual_rate_hz;
  status.error = LA_ERROR_NONE;
  status.flags = 0U;
  if (status.state != LA_STATE_IDLE)
  {
    status.state = LA_STATE_IDLE;
  }
  return true;
}

void LA_GetConfig(LA_Config *destination)
{
  if (destination != NULL)
  {
    *destination = config;
  }
}

void LA_GetStatus(LA_Status *destination)
{
  if (destination != NULL)
  {
    *destination = status;
  }
}

bool LA_Start(void)
{
  if ((status.state == LA_STATE_ARMED) || (status.state == LA_STATE_TRIGGERED) ||
      (status.state == LA_STATE_STREAMING) || (la_timer == NULL) || (la_dma == NULL))
  {
    status.error = LA_ERROR_BUSY;
    return false;
  }

  StopDma();
  produced_blocks = 0U;
  processed_blocks = 0U;
  dma_failed = false;
  write_index = 0U;
  stored_samples = 0U;
  capture_start = 0U;
  previous_valid = false;
  stream_pending = false;
  next_stream_sample = 0U;
  status.valid_samples = 0U;
  status.trigger_index = 0U;
  status.flags = 0U;
  status.error = LA_ERROR_NONE;
  status.dropped_blocks = 0U;
  start_tick = HAL_GetTick();
  pre_samples = (uint16_t)(((uint32_t)config.sample_depth *
                            config.pretrigger_percent) / 100U);
  if (pre_samples >= config.sample_depth)
  {
    pre_samples = (uint16_t)(config.sample_depth - 1U);
  }

  status.state = (config.mode == LA_MODE_STREAM) ?
                 LA_STATE_STREAMING : LA_STATE_ARMED;
  if (!StartDma())
  {
    status.error = LA_ERROR_DMA;
    status.flags |= LA_FLAG_DMA;
    status.state = LA_STATE_ERROR;
    return false;
  }
  if (config.mode == LA_MODE_STREAM)
  {
    stream_id++;
  }
  return true;
}

void LA_Stop(void)
{
  StopDma();
  stream_pending = false;
  status.state = LA_STATE_IDLE;
  status.error = LA_ERROR_NONE;
}

void LA_Task(void)
{
  uint32_t available;
  uint32_t completed_at_entry;

  if (dma_failed)
  {
    dma_failed = false;
    status.flags |= LA_FLAG_DMA;
    status.error = LA_ERROR_DMA;
    status.state = LA_STATE_ERROR;
    StopDma();
    return;
  }

  /*
   * Chi xu ly cac block da hoan tat tai thoi diem vao task. Neu ISR tao them
   * block trong luc xu ly, block do de lan goi sau de PC_Task van duoc chay.
   */
  completed_at_entry = produced_blocks;
  available = completed_at_entry - processed_blocks;

  /* Hai nua DMA: ton dong 2 block nghia la nua cu dang bi DMA ghi de. */
  if (available > 1U)
  {
    status.flags |= LA_FLAG_OVERRUN;
    status.error = LA_ERROR_OVERRUN;
    status.dropped_blocks += available - 1U;
    status.state = LA_STATE_ERROR;
    StopDma();
    return;
  }

  while ((processed_blocks != completed_at_entry) && dma_running)
  {
    uint8_t half = (uint8_t)(processed_blocks & 1U);
    const uint8_t *block = &dma_buffer[(uint16_t)half * LA_STREAM_BLOCK_SAMPLES];
    processed_blocks++;
    if (config.mode == LA_MODE_STREAM)
    {
      ProcessStreamBlock(half);
    }
    else
    {
      ProcessSnapshotBlock(block);
    }
  }

  if (dma_running && (config.mode == LA_MODE_SNAPSHOT) &&
      (config.trigger != LA_TRIGGER_NONE) && (config.timeout_ms != 0U) &&
      ((HAL_GetTick() - start_tick) >= config.timeout_ms))
  {
    StopDma();
    status.state = LA_STATE_TIMEOUT;
    status.error = LA_ERROR_NOT_READY;
  }
}

uint16_t LA_ReadSamples(uint16_t offset, uint8_t *destination, uint16_t count)
{
  uint16_t copied = 0U;

  if ((destination == NULL) || (status.state != LA_STATE_COMPLETE) ||
      (offset >= status.valid_samples))
  {
    return 0U;
  }
  if (count > (uint16_t)(status.valid_samples - offset))
  {
    count = (uint16_t)(status.valid_samples - offset);
  }
  while (copied < count)
  {
    destination[copied] = capture_buffer[(capture_start + offset + copied) &
                                         (config.sample_depth - 1U)];
    copied++;
  }
  return copied;
}

bool LA_GetStreamBlock(LA_StreamBlock *block)
{
  if ((block == NULL) || !stream_pending ||
      (status.state != LA_STATE_STREAMING))
  {
    return false;
  }
  block->samples = &dma_buffer[(uint16_t)stream_half * LA_STREAM_BLOCK_SAMPLES];
  block->count = LA_STREAM_BLOCK_SAMPLES;
  block->stream_id = stream_id;
  block->first_sample = stream_first_sample;
  return true;
}

void LA_ConsumeStreamBlock(void)
{
  stream_pending = false;
}
