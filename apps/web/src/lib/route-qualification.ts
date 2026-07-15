import "server-only";

import { createHash } from "node:crypto";

import { assessServiceRadius, haversineMiles } from "./field-operations";
import {
  isAutoQualifyingMapboxAddress,
  type MapboxAddressMatchEvidence,
} from "./route-qualification-policy";

export type ServiceAddress = {
  street: string;
  unit?: string;
  city: string;
  state: string;
  zip: string;
};

export type RouteAssessmentInput = {
  addressFingerprint: string;
  branchOriginLabel: string;
  branchOriginLatitude: number;
  branchOriginLongitude: number;
  propertyLatitude: number | null;
  propertyLongitude: number | null;
  distanceMiles: number | null;
  standardRadiusMiles: number;
  calculationMethod: "straight_line" | "manual_review";
  assessmentStatus:
    | "inside_standard_radius"
    | "outside_standard_radius"
    | "manual_review";
  provider: "manual" | "mapbox";
  calculatedAt: string | null;
  providerResolvedAddress: string | null;
  providerMatchConfidence: string | null;
  providerCoordinateAccuracy: string | null;
};

const DEFAULT_CDA_ORIGIN = {
  label: "Downtown Coeur d'Alene, Idaho",
  latitude: 47.6777,
  longitude: -116.7805,
};

function configuredNumber(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function normalizedAddress(address: ServiceAddress) {
  return [address.street, address.unit, address.city, address.state, address.zip, "US"]
    .filter(Boolean)
    .join(", ")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function addressFingerprint(address: ServiceAddress) {
  return createHash("sha256").update(normalizedAddress(address)).digest("hex");
}

function originConfiguration() {
  const latitude = configuredNumber(
    "CDA_BRANCH_ORIGIN_LATITUDE",
    DEFAULT_CDA_ORIGIN.latitude,
  );
  const longitude = configuredNumber(
    "CDA_BRANCH_ORIGIN_LONGITUDE",
    DEFAULT_CDA_ORIGIN.longitude,
  );
  const radiusMiles = configuredNumber("CDA_STANDARD_RADIUS_MILES", 30);
  if (
    latitude < -90 ||
    latitude > 90 ||
    longitude < -180 ||
    longitude > 180 ||
    radiusMiles <= 0 ||
    radiusMiles > 250
  ) {
    throw new Error("Configured branch routing origin or radius is invalid");
  }
  return {
    label: process.env.CDA_BRANCH_ORIGIN_LABEL?.trim() || DEFAULT_CDA_ORIGIN.label,
    latitude,
    longitude,
    radiusMiles,
  };
}

export function createManualRequestLocationAssessment(
  address: ServiceAddress,
): RouteAssessmentInput {
  const origin = originConfiguration();
  return {
    addressFingerprint: addressFingerprint(address),
    branchOriginLabel: origin.label,
    branchOriginLatitude: origin.latitude,
    branchOriginLongitude: origin.longitude,
    propertyLatitude: null,
    propertyLongitude: null,
    distanceMiles: null,
    standardRadiusMiles: origin.radiusMiles,
    calculationMethod: "manual_review",
    assessmentStatus: "manual_review",
    provider: "manual",
    calculatedAt: null,
    providerResolvedAddress: null,
    providerMatchConfidence: null,
    providerCoordinateAccuracy: null,
  };
}

export async function assessRequestLocation(
  address: ServiceAddress,
): Promise<RouteAssessmentInput> {
  const fallback = createManualRequestLocationAssessment(address);
  const token = process.env.MAPBOX_ACCESS_TOKEN?.trim();
  const permanentEnabled =
    process.env.MAPBOX_PERMANENT_GEOCODING_ENABLED === "true";
  if (!token || !permanentEnabled) return fallback;

  try {
    const url = new URL("https://api.mapbox.com/search/geocode/v6/forward");
    url.searchParams.set("address_line1", address.street);
    url.searchParams.set("place", address.city);
    url.searchParams.set("region", address.state);
    url.searchParams.set("postcode", address.zip);
    url.searchParams.set("country", "US");
    url.searchParams.set("access_token", token);
    url.searchParams.set("permanent", "true");
    url.searchParams.set("autocomplete", "false");
    url.searchParams.set("limit", "1");
    url.searchParams.set("types", "address");
    const response = await fetch(url, {
      cache: "no-store",
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return fallback;
    const payload = (await response.json()) as {
      features?: Array<{
        geometry?: { coordinates?: unknown };
        properties?: {
          feature_type?: unknown;
          full_address?: unknown;
          coordinates?: { accuracy?: unknown };
          match_code?: {
            address_number?: unknown;
            street?: unknown;
            postcode?: unknown;
            place?: unknown;
            region?: unknown;
            country?: unknown;
            confidence?: unknown;
          };
        };
      }>;
    };
    const feature = payload.features?.[0];
    const coordinates = feature?.geometry?.coordinates;
    if (
      !Array.isArray(coordinates) ||
      coordinates.length < 2 ||
      !Number.isFinite(coordinates[0]) ||
      !Number.isFinite(coordinates[1])
    ) {
      return fallback;
    }
    const propertyLongitude = Number(coordinates[0]);
    const propertyLatitude = Number(coordinates[1]);
    if (
      propertyLatitude < -90 ||
      propertyLatitude > 90 ||
      propertyLongitude < -180 ||
      propertyLongitude > 180
    ) {
      return fallback;
    }
    const properties = feature?.properties;
    const matchCode = properties?.match_code;
    const text = (value: unknown) =>
      typeof value === "string" ? value : null;
    const enumText = (value: unknown, allowed: readonly string[]) => {
      const candidate = text(value);
      return candidate && allowed.includes(candidate) ? candidate : null;
    };
    const matchEvidence: MapboxAddressMatchEvidence = {
      featureType: text(properties?.feature_type),
      confidence: enumText(matchCode?.confidence, [
        "exact",
        "high",
        "medium",
        "low",
      ]),
      addressNumber: text(matchCode?.address_number),
      street: text(matchCode?.street),
      postcode: text(matchCode?.postcode),
      place: text(matchCode?.place),
      region: text(matchCode?.region),
      country: text(matchCode?.country),
      coordinateAccuracy: enumText(properties?.coordinates?.accuracy, [
        "rooftop",
        "parcel",
        "point",
        "interpolated",
        "approximate",
        "intersection",
      ]),
    };
    const distanceMiles = haversineMiles(
      {
        latitude: fallback.branchOriginLatitude,
        longitude: fallback.branchOriginLongitude,
      },
      { latitude: propertyLatitude, longitude: propertyLongitude },
    );
    const radius = assessServiceRadius(
      distanceMiles,
      fallback.standardRadiusMiles,
    );
    const trusted = isAutoQualifyingMapboxAddress(matchEvidence);
    return {
      ...fallback,
      propertyLatitude,
      propertyLongitude,
      distanceMiles: Math.round(distanceMiles * 100) / 100,
      calculationMethod: trusted ? "straight_line" : "manual_review",
      assessmentStatus: trusted ? radius.status : "manual_review",
      provider: "mapbox",
      calculatedAt: new Date().toISOString(),
      providerResolvedAddress: text(properties?.full_address),
      providerMatchConfidence: matchEvidence.confidence,
      providerCoordinateAccuracy: matchEvidence.coordinateAccuracy,
    };
  } catch {
    return fallback;
  }
}
