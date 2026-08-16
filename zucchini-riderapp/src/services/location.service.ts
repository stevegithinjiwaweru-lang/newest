import client from "../api/client";
import { endpoints } from "../api/endpoints";

/** Push GPS coordinates for the authenticated rider. */
export async function updateMyLocation(riderId: string, lat: number, lng: number) {
  const { data } = await client.post(endpoints.riders.locationUpdate(riderId), { lat, lng });
  return data;
}
