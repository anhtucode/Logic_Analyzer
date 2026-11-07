#include <assert.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#include "la_acquisition.h"
#include "la_com.h"
#include "la_controller.h"
#include "la_stream.h"
#include "la_usb_cdc_transport.h"

#define TEST_SYNC_0       0xA5U
#define TEST_SYNC_1       0x5AU
#define TEST_VERSION      0x02U
#define TEST_GET_INFO     0x01U
#define TEST_READ_CAPTURE 0x07U
#define TEST_INFO         0x82U
#define TEST_CAPTURE_DATA 0x85U

static la_usb_cdc_rx_callback_t usb_rx_callback;
static bool usb_configured = true;
static bool usb_tx_ready = true;
static uint8_t transmitted[256];
static uint16_t transmitted_length;

static la_config_t config =
{
  1000000U, 0xFFU, 0U, TRIG_RISING, 50U, 0U
};
static la_sample_t capture_samples[8] =
    {0x10U, 0x11U, 0x12U, 0x13U, 0x14U, 0x15U, 0x16U, 0x17U};
static capture_result_t capture_result;
static uint8_t capture_lock_count;
static uint8_t capture_release_count;

static uint16_t CrcByte(uint16_t crc, uint8_t value)
{
  uint8_t bit;
  crc ^= (uint16_t)value << 8;
  for (bit = 0U; bit < 8U; bit++)
  {
    crc = (crc & 0x8000U) ? (uint16_t)((crc << 1) ^ 0x1021U)
                          : (uint16_t)(crc << 1);
  }
  return crc;
}

static uint16_t BuildCommand(uint8_t *frame, uint8_t type, uint8_t sequence,
                             const uint8_t *payload, uint16_t length)
{
  uint16_t index;
  uint16_t crc = 0xFFFFU;

  frame[0] = TEST_SYNC_0;
  frame[1] = TEST_SYNC_1;
  frame[2] = TEST_VERSION;
  frame[3] = type;
  frame[4] = sequence;
  frame[5] = (uint8_t)length;
  frame[6] = (uint8_t)(length >> 8);
  if (length != 0U)
  {
    memcpy(&frame[7], payload, length);
  }
  for (index = 2U; index < (uint16_t)(7U + length); index++)
  {
    crc = CrcByte(crc, frame[index]);
  }
  frame[7U + length] = (uint8_t)crc;
  frame[8U + length] = (uint8_t)(crc >> 8);
  return (uint16_t)(9U + length);
}

static void CompleteUsbTx(void)
{
  usb_tx_ready = true;
}

bool LA_USB_CDC_TransportInit(la_usb_cdc_rx_callback_t callback)
{
  usb_rx_callback = callback;
  return callback != 0;
}

bool LA_USB_CDC_IsConfigured(void)
{
  return usb_configured;
}

bool LA_USB_CDC_TxReady(void)
{
  return usb_configured && usb_tx_ready;
}

bool LA_USB_CDC_Transmit(const uint8_t *data, uint16_t length)
{
  if (!LA_USB_CDC_TxReady() ||
      ((uint32_t)transmitted_length + length > sizeof(transmitted)))
  {
    return false;
  }
  memcpy(&transmitted[transmitted_length], data, length);
  transmitted_length = (uint16_t)(transmitted_length + length);
  usb_tx_ready = false;
  return true;
}

void LA_USB_CDC_OnReceive(const uint8_t *data, uint16_t length)
{
  if (usb_rx_callback != 0)
  {
    usb_rx_callback(data, length);
  }
}

la_state_t LA_GetState(void) { return LA_COMPLETE; }
const la_config_t *LA_GetConfig(void) { return &config; }
uint32_t LA_GetConfigRevision(void) { return 1U; }
uint32_t LA_GetCaptureId(void) { return capture_result.capture_id; }
uint16_t LA_GetFlags(void) { return 0U; }
const capture_result_t *LA_GetCaptureResult(void) { return &capture_result; }

const capture_result_t *LA_LockCapture(la_capture_owner_t owner)
{
  assert(owner == LA_CAPTURE_OWNER_PC);
  capture_lock_count++;
  return &capture_result;
}

void LA_ReleaseCapture(la_capture_owner_t owner)
{
  assert(owner == LA_CAPTURE_OWNER_PC);
  capture_release_count++;
}

control_result_t LA_DispatchControl(const control_request_t *request)
{
  (void)request;
  return CONTROL_ACK;
}

bool LA_StreamIsRunning(void) { return false; }
const la_stream_block_t *LA_StreamPeekBlock(void) { return 0; }
void LA_StreamConsumeBlock(void) { }
control_result_t LA_StopStream(void) { return CONTROL_ACK; }
bool LA_AcquisitionIsRunning(void) { return false; }

int main(void)
{
  uint8_t command[32];
  uint8_t requested_id[4];
  uint16_t command_length;
  uint8_t iteration;
  static const uint8_t expected_samples[8] =
      {0x16U, 0x17U, 0x10U, 0x11U, 0x12U, 0x13U, 0x14U, 0x15U};

  capture_result.ring = capture_samples;
  capture_result.ring_capacity = 8U;
  capture_result.start_offset = 6U;
  capture_result.sample_count = 8U;
  capture_result.trigger_index = 4U;
  capture_result.sample_rate_hz = 1000000U;
  capture_result.channel_mask = 0xFFU;
  capture_result.trigger_channel = 0U;
  capture_result.trigger_edge = TRIG_RISING;
  capture_result.flags = 0U;
  capture_result.capture_id = 7U;

  assert(COM_Init());
  COM_Process();
  if (!usb_tx_ready)
  {
    CompleteUsbTx();
    COM_Process();
  }
  transmitted_length = 0U;

  command_length = BuildCommand(command, TEST_GET_INFO, 0x21U, 0, 0U);
  LA_USB_CDC_OnReceive(command, command_length);
  COM_Process();
  assert(transmitted_length == 25U);
  assert(transmitted[0] == TEST_SYNC_0);
  assert(transmitted[1] == TEST_SYNC_1);
  assert(transmitted[3] == TEST_INFO);
  assert(transmitted[4] == 0x21U);

  CompleteUsbTx();
  COM_Process();
  transmitted_length = 0U;

  requested_id[0] = 7U;
  requested_id[1] = 0U;
  requested_id[2] = 0U;
  requested_id[3] = 0U;
  command_length = BuildCommand(command, TEST_READ_CAPTURE, 0x31U,
                                requested_id, sizeof(requested_id));
  LA_USB_CDC_OnReceive(command, command_length);
  COM_Process();
  assert(capture_lock_count == 1U);

  for (iteration = 0U; iteration < 12U; iteration++)
  {
    COM_Process();
    if (!usb_tx_ready)
    {
      CompleteUsbTx();
    }
    if (capture_release_count != 0U)
    {
      break;
    }
  }

  assert(capture_release_count == 1U);
  assert(transmitted_length == 35U);
  assert(transmitted[3] == TEST_CAPTURE_DATA);
  assert(transmitted[4] == 0x31U);
  assert(transmitted[5] == 26U);
  assert(transmitted[6] == 0U);
  assert(memcmp(&transmitted[25], expected_samples,
                sizeof(expected_samples)) == 0);

  puts("la USB CDC communication tests passed");
  return 0;
}
