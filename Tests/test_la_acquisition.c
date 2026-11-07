#include <assert.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>

#include "la_acquisition.h"
#include "la_types.h"

TIM_TypeDef mock_tim2;
DMA_Channel_TypeDef mock_dma1_channel2;
GPIO_TypeDef mock_gpioa;
RCC_TypeDef mock_rcc;

static uint32_t dma_source;
static uint32_t dma_destination;
static uint32_t dma_length;
static uint32_t processed_blocks;
static la_acquisition_error_t reported_error;
static bool error_reported;

uint32_t HAL_RCC_GetPCLK1Freq(void)
{
  return 36000000U;
}

uint32_t HAL_GetTick(void)
{
  return 0U;
}

HAL_StatusTypeDef HAL_DMA_Start_IT(DMA_HandleTypeDef *dma,
                                   uint32_t source,
                                   uint32_t destination,
                                   uint32_t length)
{
  dma_source = source;
  dma_destination = destination;
  dma_length = length;
  dma->State = HAL_DMA_STATE_BUSY;
  return HAL_OK;
}

HAL_StatusTypeDef HAL_DMA_Abort(DMA_HandleTypeDef *dma)
{
  dma->State = HAL_DMA_STATE_READY;
  return HAL_OK;
}

static bool ProcessBlock(const la_sample_t *samples, uint16_t sample_count)
{
  assert(samples != 0);
  assert(sample_count == LA_DMA_HALF_SAMPLE_COUNT);
  processed_blocks++;
  return true;
}

static void ReportError(la_acquisition_error_t error)
{
  reported_error = error;
  error_reported = true;
}

static void ResetTestState(void)
{
  processed_blocks = 0U;
  error_reported = false;
  reported_error = LA_ACQ_ERROR_DMA;
}

int main(void)
{
  TIM_HandleTypeDef timer;
  DMA_HandleTypeDef dma;

  timer.Instance = TIM2;
  dma.Instance = DMA1_Channel2;
  dma.State = HAL_DMA_STATE_READY;
  mock_rcc.CFGR = RCC_CFGR_PPRE1;

  assert(LA_AcquisitionInit(&timer, &dma));
  LA_AcquisitionSetCallbacks(ProcessBlock, ReportError);

  assert(LA_AcquisitionStart(1000000U));
  assert(timer.Instance->PSC == 0U);
  assert(timer.Instance->ARR == 71U);
  assert(dma_source == (uint32_t)&GPIOA->IDR);
  assert(dma_destination != 0U);
  assert(dma_length == LA_DMA_STAGE_SAMPLE_COUNT);
  assert((timer.Instance->DIER & TIM_DMA_UPDATE) != 0U);
  assert(LA_AcquisitionIsRunning());

  dma.XferHalfCpltCallback(&dma);
  LA_AcquisitionProcessPendingBlocks();
  assert(processed_blocks == 1U);
  assert(!error_reported);

  dma.XferCpltCallback(&dma);
  LA_AcquisitionProcessPendingBlocks();
  assert(processed_blocks == 2U);
  LA_AcquisitionStop();

  ResetTestState();
  assert(LA_AcquisitionStart(1000U));
  assert(timer.Instance->PSC == 1U);
  assert(timer.Instance->ARR == 35999U);
  LA_AcquisitionStop();

  ResetTestState();
  assert(LA_AcquisitionStart(10000U));
  assert(timer.Instance->ARR == 7199U);
  dma.XferHalfCpltCallback(&dma);
  dma.XferCpltCallback(&dma);
  LA_AcquisitionProcessPendingBlocks();
  assert(error_reported);
  assert(reported_error == LA_ACQ_ERROR_BLOCK_OVERRUN);
  assert(!LA_AcquisitionIsRunning());

  ResetTestState();
  assert(LA_AcquisitionStart(500000U));
  dma.XferErrorCallback(&dma);
  LA_AcquisitionProcessPendingBlocks();
  assert(error_reported);
  assert(reported_error == LA_ACQ_ERROR_DMA);
  assert(!LA_AcquisitionIsRunning());

  puts("la acquisition tests passed");
  return 0;
}
