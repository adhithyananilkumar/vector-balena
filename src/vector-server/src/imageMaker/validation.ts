export class BaseImageValidationError extends Error {}

const DEVICE_TYPE_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/;

export const assertDeviceType = (value: unknown): string => {
  if (typeof value !== 'string' || !DEVICE_TYPE_PATTERN.test(value)) {
    throw new BaseImageValidationError('A valid device type slug is required.');
  }
  return value;
};

export const assertVersion = (value: unknown): string => {
  if (typeof value !== 'string' || !VERSION_PATTERN.test(value)) {
    throw new BaseImageValidationError('A valid balenaOS version is required, for example 9.0.4+rev1.');
  }
  return value;
};
