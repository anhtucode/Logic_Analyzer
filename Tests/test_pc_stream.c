/* Host test: chay dung source firmware, thay thanh ghi va USB bang mock.
 * Khong chung minh throughput tren STM32 that. */
#include "acquisition.h"
#include "self_test.h"
#include "usb_device.h"
#include "usbd_cdc.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>

static RCC_TypeDef test_rcc;
static GPIO_TypeDef test_gpio;
#undef RCC
#undef GPIOA
#define RCC (&test_rcc)
#define GPIOA (&test_gpio)
static void *CopyWithDmaInterrupt(void *dst, const void *src, size_t count);
#define memcpy CopyWithDmaInterrupt
#include "../Core/Src/acquisition.c"
#undef memcpy
#include "../Core/Src/pc_interface.c"

static TIM_TypeDef timer_regs;
static DMA_Channel_TypeDef dma_regs;
static TIM_HandleTypeDef timer;
static DMA_HandleTypeDef dma;
static USBD_CDC_HandleTypeDef cdc;
USBD_HandleTypeDef hUsbDeviceFS;
static bool interrupt_copy, usb_busy;
static uint8_t *usb_pointer;
static uint16_t usb_length;
static uint32_t tick, transfers;

uint32_t HAL_GetTick(void) { return tick; }
uint32_t HAL_RCC_GetPCLK1Freq(void) { return 36000000U; }
HAL_StatusTypeDef HAL_DMA_Start_IT(DMA_HandleTypeDef *handle, uint32_t src,
                                 uint32_t dst, uint32_t count)
{
  (void)src; (void)dst;
  assert(count == LA_DMA_SAMPLES);
  handle->Instance->CNDTR = count;
  return HAL_OK;
}
HAL_StatusTypeDef HAL_DMA_Abort(DMA_HandleTypeDef *handle)
{ (void)handle; return HAL_OK; }
HAL_StatusTypeDef HAL_TIM_Base_Start(TIM_HandleTypeDef *handle)
{ (void)handle; return HAL_OK; }
HAL_StatusTypeDef HAL_TIM_Base_Stop(TIM_HandleTypeDef *handle)
{ (void)handle; return HAL_OK; }
void SelfTest_Stop(void) {}
bool SelfTest_Start(SelfTest_Mode mode, bool repeat)
{ (void)mode; (void)repeat; return true; }
bool SelfTest_IsActive(void) { return false; }
uint8_t CDC_Transmit_FS(uint8_t *data, uint16_t length)
{
  if (usb_busy || cdc.TxState) return USBD_BUSY;
  usb_pointer = data;
  usb_length = length;
  transfers++;
  cdc.TxState = 1U;
  return USBD_OK;
}

static void *CopyWithDmaInterrupt(void *dst, const void *src, size_t count)
{
  void *result = memcpy(dst, src, count);
  if (interrupt_copy)
  {
    interrupt_copy = false;
    produced_blocks++;
    dma_regs.CNDTR = LA_DMA_SAMPLES;
  }
  return result;
}

static void Reset(void)
{
  LA_Stop();
  memset(&timer_regs, 0, sizeof(timer_regs));
  memset(&dma_regs, 0, sizeof(dma_regs));
  memset(&timer, 0, sizeof(timer));
  memset(&dma, 0, sizeof(dma));
  memset(&cdc, 0, sizeof(cdc));
  timer.Instance = &timer_regs;
  dma.Instance = &dma_regs;
  test_rcc.CFGR = RCC_CFGR_PPRE1_DIV2;
  LA_Init(&timer, &dma);
  PC_Init();
  hUsbDeviceFS.dev_state = USBD_STATE_CONFIGURED;
  hUsbDeviceFS.pClassData = &cdc;
  usb_busy = interrupt_copy = false;
  transfers = 0;
}

static void StartStream(uint32_t rate)
{
  LA_Config value;
  LA_GetConfig(&value);
  value.mode = LA_MODE_STREAM;
  value.requested_rate_hz = rate;
  assert(LA_SetConfig(&value));
  assert(value.requested_rate_hz == config.actual_rate_hz);
  assert(LA_Start());
}

static void Produce(uint8_t pattern)
{
  uint8_t half = (uint8_t)(produced_blocks & 1U);
  memset(&dma_buffer[half * LA_STREAM_BLOCK_SAMPLES], pattern, LA_STREAM_BLOCK_SAMPLES);
  dma_regs.CNDTR = half ? LA_DMA_SAMPLES : LA_STREAM_BLOCK_SAMPLES;
  if (half) dma.XferCpltCallback(&dma);
  else dma.XferHalfCpltCallback(&dma);
  LA_Task();
}

static void CheckQueue(void)
{
  LA_StreamBlock block;
  unsigned i, k;
  Reset();
  StartStream(500000U);
  assert(sizeof(workspace) == 8192U);
  for (i = 0; i < 8; i++) Produce((uint8_t)i);
  assert(status.state == LA_STATE_STREAMING);
  assert(stream_queue_write - stream_queue_read == 8U);
  for (i = 0; i < 8; i++)
  {
    assert(LA_GetStreamBlock(&block));
    assert(block.first_sample == i * 1024U);
    for (k = 0; k < block.count; k++) assert(block.samples[k] == i);
    LA_ConsumeStreamBlock();
  }
  assert(!LA_GetStreamBlock(&block));
  for (i = 8; i < 400; i++)
  {
    Produce((uint8_t)i);
    assert(LA_GetStreamBlock(&block));
    assert(block.first_sample == i * 1024U && block.samples[0] == (uint8_t)i);
    LA_ConsumeStreamBlock();
  }
  stream_queue_write = stream_queue_read = 0x003fffffU;
  Produce(0xA5);
  assert(LA_GetStreamBlock(&block) && block.first_sample == 0xfffffc00U);
  LA_ConsumeStreamBlock();
  Produce(0x55);
  assert(LA_GetStreamBlock(&block) && block.first_sample == 0U);
  LA_ConsumeStreamBlock();
  for (i = 0; i < 9; i++) Produce(0xDD);
  assert(status.state == LA_STATE_ERROR && status.error == LA_ERROR_OVERRUN);
  assert(status.flags == (LA_FLAG_OVERRUN | LA_FLAG_QUEUE_FULL));
  assert(status.dropped_blocks == 1 && !dma_running);
  assert(!LA_GetStreamBlock(&block));
  LA_Stop();
  assert(stream_queue_write == 0 && stream_queue_read == 0);
  StartStream(100000U);
  Produce(0xC3);
  assert(LA_GetStreamBlock(&block) && block.first_sample == 0 && block.samples[0] == 0xC3);
}

static void CheckLateDma(void)
{
  Reset(); StartStream(500000U);
  dma.XferHalfCpltCallback(&dma);
  dma.XferCpltCallback(&dma);
  LA_Task();
  assert(status.error == LA_ERROR_OVERRUN && !dma_running);
  assert(status.flags == (LA_FLAG_OVERRUN | LA_FLAG_DMA_LATE));
  Reset(); StartStream(500000U);
  dma.XferHalfCpltCallback(&dma);
  dma_regs.CNDTR = 1800U; /* DMA da quay lai nua 0, IRQ co the chua chay. */
  LA_Task();
  assert(status.error == LA_ERROR_OVERRUN && stream_queue_write == 0);
  assert(status.flags == (LA_FLAG_OVERRUN | LA_FLAG_DMA_LATE));
  Reset(); StartStream(500000U);
  interrupt_copy = true;
  Produce(0x33);
  assert(status.error == LA_ERROR_OVERRUN && stream_queue_write == 0);
  assert(status.flags == (LA_FLAG_OVERRUN | LA_FLAG_DMA_LATE));
}

static uint16_t ReferenceCrc(const uint8_t *data, uint16_t length)
{
  uint16_t crc = 0xffffU;
  unsigned bit;
  while (length--)
  {
    crc ^= (uint16_t)*data++ << 8;
    for (bit = 0; bit < 8; bit++)
      crc = (uint16_t)((crc << 1) ^ ((crc & 0x8000U) ? 0x1021U : 0U));
  }
  return crc;
}

static void Command(uint8_t command, uint8_t sequence)
{
  uint8_t frame[9] = { 0xa5, 0x5a, 1, 0, 0, 0, 0, 0, 0 };
  frame[3] = command; frame[4] = sequence;
  PutU16(&frame[7], ReferenceCrc(&frame[2], 5));
  PC_USB_Receive(frame, sizeof(frame));
}

static void CheckUsb(void)
{
  uint8_t saved[1100];
  unsigned i;
  Reset(); StartStream(500000U);
  Produce(0x51);
  usb_busy = true;
  PC_Task();
  assert(tx_queued && !tx_in_flight && stream_queue_read == 1U);
  memcpy(saved, tx_buffer, tx_length);
  Produce(0x52);
  PC_Task();
  assert(!memcmp(saved, tx_buffer, tx_length) && stream_queue_read == 1U);
  usb_busy = false;
  PC_Task();
  assert(tx_in_flight && usb_length == 1049U && usb_pointer == tx_buffer);
  assert(GetU32(&usb_pointer[11]) == 0U && usb_pointer[23] == 0x51);
  assert(GetU16(&usb_pointer[1047]) == ReferenceCrc(&usb_pointer[2], 1045));
  Command(CMD_GET_STATUS, 11);
  for (i = 0; i < 4; i++) { Produce(0x53); PC_Task(); }
  assert(!memcmp(saved, tx_buffer, tx_length)); /* USB dang so huu TX RAM. */
  cdc.TxState = 0;
  PC_Task();
  assert(usb_pointer[3] == RSP_STATUS && usb_pointer[4] == 11);
  assert(usb_pointer[7] == LA_STATE_STREAMING);
  Command(CMD_STOP_STREAM, 12);
  cdc.TxState = 0;
  PC_Task();
  assert(status.state == LA_STATE_IDLE && usb_pointer[3] == RSP_ACK);
  assert(usb_pointer[7] == CMD_STOP_STREAM && stream_queue_write == 0U);
  cdc.TxState = 0;
  PC_Task();
  StartStream(100000U); Produce(0x44); PC_Task();
  hUsbDeviceFS.dev_state = USBD_STATE_DEFAULT;
  PC_Task();
  assert(status.state == LA_STATE_IDLE && !tx_in_flight && !tx_queued);
  hUsbDeviceFS.dev_state = USBD_STATE_CONFIGURED;
  cdc.TxState = 0;
  Command(CMD_START_STREAM, 13);
  PC_Task();
  assert(usb_pointer[3] == RSP_ACK && status.state == LA_STATE_STREAMING);
  cdc.TxState = 0;
  Produce(0x66); PC_Task();
  assert(usb_pointer[3] == RSP_STREAM && GetU32(&usb_pointer[11]) == 0U);
}

static void CheckCapture(void)
{
  LA_Config value;
  uint8_t result[8192];
  unsigned block, i;
  Reset();
  LA_GetConfig(&value);
  value.mode = LA_MODE_SNAPSHOT;
  value.trigger = LA_TRIGGER_NONE;
  value.sample_depth = 8192;
  assert(LA_SetConfig(&value) && LA_Start());
  for (block = 0; block < 8; block++) Produce((uint8_t)block);
  assert(status.state == LA_STATE_COMPLETE && status.valid_samples == 8192);
  assert(LA_ReadSamples(0, result, sizeof(result)) == sizeof(result));
  for (i = 0; i < sizeof(result); i++) assert(result[i] == i / 1024);
  value.trigger = LA_TRIGGER_RISING;
  value.pretrigger_percent = 50;
  assert(LA_SetConfig(&value) && LA_Start());
  /* Trigger sau khi capture circular da wrap; van giu du pre/post. */
  for (block = 0; block < 13; block++)
  {
    unsigned half = produced_blocks & 1U;
    for (i = 0; i < 1024; i++)
      dma_buffer[half * 1024 + i] = block * 1024 + i < 9000 ? 0xaa : 0xab;
    dma_regs.CNDTR = half ? 2048 : 1024;
    if (half) dma.XferCpltCallback(&dma); else dma.XferHalfCpltCallback(&dma);
    LA_Task();
  }
  assert(status.state == LA_STATE_COMPLETE && status.trigger_index == 4096);
  assert(LA_ReadSamples(0, result, sizeof(result)) == sizeof(result));
  for (i = 0; i < sizeof(result); i++) assert(result[i] == (i < 4096 ? 0xaa : 0xab));
}

int main(void)
{
  const uint32_t rates[] = {1000U, 5000U, 10000U, 50000U, 100000U, 500000U};
  LA_Config value;
  uint8_t data[1050];
  unsigned i;
  Reset();
  for (i = 0; i < sizeof(rates) / sizeof(rates[0]); i++)
  { StartStream(rates[i]); LA_Stop(); }
  LA_GetConfig(&value);
  value.requested_rate_hz = 1000000U;
  assert(!LA_SetConfig(&value));
  value.mode = LA_MODE_SNAPSHOT;
  assert(LA_SetConfig(&value));
  assert(Crc16((const uint8_t *)"123456789", 9) == 0x29b1U);
  for (i = 0; i < sizeof(data); i++) data[i] = (uint8_t)(i * 73U + i / 7U);
  for (i = 0; i <= sizeof(data); i++) assert(Crc16(data, (uint16_t)i) == ReferenceCrc(data, (uint16_t)i));
  CheckQueue();
  CheckLateDma();
  CheckUsb();
  CheckCapture();
  puts("PASS PC stream: rates, CRC, queue, index wrap, DMA overwrite, USB BUSY/lifetime, Stop/reconnect; capture trigger/no-trigger");
  return 0;
}
