#ifndef ACQUISITION_H
#define ACQUISITION_H

#include "stm32f1xx_hal.h"
#include <stdbool.h>
#include <stdint.h>

#define LA_MAX_SAMPLES          8192U
#define LA_DMA_SAMPLES          2048U
#define LA_STREAM_BLOCK_SAMPLES 1024U

typedef enum
{
  LA_MODE_SNAPSHOT = 0,
  LA_MODE_STREAM = 1
} LA_Mode;

typedef enum
{
  LA_TRIGGER_NONE = 0,
  LA_TRIGGER_RISING = 1,
  LA_TRIGGER_FALLING = 2
} LA_Trigger;

typedef enum
{
  LA_STATE_IDLE = 0,
  LA_STATE_ARMED,
  LA_STATE_TRIGGERED,
  LA_STATE_COMPLETE,
  LA_STATE_STREAMING,
  LA_STATE_TIMEOUT,
  LA_STATE_ERROR
} LA_State;

typedef enum
{
  LA_ERROR_NONE = 0,
  LA_ERROR_INVALID_CONFIG,
  LA_ERROR_BUSY,
  LA_ERROR_DMA,
  LA_ERROR_OVERRUN,
  LA_ERROR_NOT_READY,
  LA_ERROR_BAD_PACKET
} LA_Error;

typedef struct
{
  LA_Mode mode;
  LA_Trigger trigger;
  uint8_t trigger_channel;
  uint8_t pretrigger_percent;
  uint16_t sample_depth;
  uint32_t requested_rate_hz;
  uint32_t actual_rate_hz;
  uint32_t timeout_ms;
} LA_Config;

typedef struct
{
  LA_State state;
  LA_Error error;
  uint16_t flags;
  uint32_t capture_id;
  uint16_t valid_samples;
  uint16_t trigger_index;
  uint32_t actual_rate_hz;
  uint32_t dropped_blocks;
} LA_Status;

typedef struct
{
  const uint8_t *samples;
  uint16_t count;
  uint32_t stream_id;
  uint32_t first_sample;
} LA_StreamBlock;

void LA_Init(TIM_HandleTypeDef *timer, DMA_HandleTypeDef *dma);
void LA_Task(void);
bool LA_SetConfig(const LA_Config *config);
void LA_GetConfig(LA_Config *config);
void LA_GetStatus(LA_Status *status);
bool LA_Start(void);
void LA_Stop(void);
uint16_t LA_ReadSamples(uint16_t offset, uint8_t *destination, uint16_t count);
bool LA_GetStreamBlock(LA_StreamBlock *block);
void LA_ConsumeStreamBlock(void);

#endif
