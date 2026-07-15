export type MapboxAddressMatchEvidence = {
  featureType: string | null;
  confidence: string | null;
  addressNumber: string | null;
  street: string | null;
  postcode: string | null;
  place: string | null;
  region: string | null;
  country: string | null;
  coordinateAccuracy: string | null;
};

export function isAutoQualifyingMapboxAddress(
  evidence: MapboxAddressMatchEvidence,
) {
  return (
    evidence.featureType === "address" &&
    evidence.confidence === "exact" &&
    evidence.addressNumber === "matched" &&
    evidence.street === "matched" &&
    evidence.postcode === "matched" &&
    evidence.place === "matched" &&
    evidence.region === "matched" &&
    ["matched", "inferred"].includes(evidence.country ?? "") &&
    ["rooftop", "parcel", "point"].includes(
      evidence.coordinateAccuracy ?? "",
    )
  );
}
