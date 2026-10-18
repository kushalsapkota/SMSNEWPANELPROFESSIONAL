import { PipeTransform } from '@nestjs/common';
import { AppError } from './errors';
import { isUuid } from '../tenancy/scope.service';

/** `@Param('id', UuidPipe)` — malformed ids are 404 (they can't name any resource). */
export class UuidPipe implements PipeTransform<string, string> {
  transform(value: string): string {
    if (!isUuid(value)) throw AppError.notFound('Resource');
    return value.toLowerCase();
  }
}
