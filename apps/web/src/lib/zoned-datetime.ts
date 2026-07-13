const LOCAL_DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

type WallClock = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

function parseWallClock(value: string): WallClock {
  const match = LOCAL_DATE_TIME.exec(value);
  if (!match) throw new Error("Use a complete local date and time");
  const wallClock = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: Number(match[6] ?? 0),
  };
  const validation = new Date(
    Date.UTC(
      wallClock.year,
      wallClock.month - 1,
      wallClock.day,
      wallClock.hour,
      wallClock.minute,
      wallClock.second,
    ),
  );
  if (
    validation.getUTCFullYear() !== wallClock.year ||
    validation.getUTCMonth() + 1 !== wallClock.month ||
    validation.getUTCDate() !== wallClock.day ||
    validation.getUTCHours() !== wallClock.hour ||
    validation.getUTCMinutes() !== wallClock.minute ||
    validation.getUTCSeconds() !== wallClock.second
  ) {
    throw new Error("Local date and time is invalid");
  }
  return wallClock;
}

function formattedWallClock(
  formatter: Intl.DateTimeFormat,
  instant: number,
): WallClock {
  const values = Object.fromEntries(
    formatter
      .formatToParts(instant)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  );
  return {
    year: values.year,
    month: values.month,
    day: values.day,
    hour: values.hour,
    minute: values.minute,
    second: values.second,
  };
}

function sameWallClock(left: WallClock, right: WallClock): boolean {
  return Object.keys(left).every(
    (key) => left[key as keyof WallClock] === right[key as keyof WallClock],
  );
}

export function localDateTimeToUtc(
  localValue: string,
  timeZone: string,
): string {
  const requested = parseWallClock(localValue);
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
  } catch {
    throw new Error("Territory timezone is invalid");
  }

  const wallClockAsUtc = Date.UTC(
    requested.year,
    requested.month - 1,
    requested.day,
    requested.hour,
    requested.minute,
    requested.second,
  );
  const matches: number[] = [];
  // IANA UTC offsets are bounded by -12:00 and +14:00. Searching by minute
  // makes half-hour/quarter-hour zones and DST transitions deterministic.
  for (let offsetMinutes = -14 * 60; offsetMinutes <= 14 * 60; offsetMinutes += 1) {
    const candidate = wallClockAsUtc + offsetMinutes * 60_000;
    if (sameWallClock(formattedWallClock(formatter, candidate), requested)) {
      matches.push(candidate);
    }
  }
  if (matches.length === 0) {
    throw new Error(
      "That local time does not exist because of a daylight-saving transition",
    );
  }
  if (matches.length > 1) {
    throw new Error(
      "That local time occurs twice because of a daylight-saving transition; choose another time",
    );
  }
  return new Date(matches[0]).toISOString();
}

export function validateUtcInterval(
  startAt: string,
  endAt: string,
  options: { maxMinutes: number; allowPastMinutes?: number },
): void {
  const start = Date.parse(startAt);
  const end = Date.parse(endAt);
  const allowPast = options.allowPastMinutes ?? 5;
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    start < Date.now() - allowPast * 60_000 ||
    end <= start ||
    end - start > options.maxMinutes * 60_000
  ) {
    throw new Error("Local date-time interval is invalid");
  }
}
