export type Restaurant = {
  id: number;
  name: string;
  city: string;
  category: string;
  cuisine: string;
  overall: number;
  food: number | null;
  value: number | null;
  service: number | null;
  ambiance: number | null;
  vegan_options: number | null;
  note: string | null;
  created_at: string;
  updated_at: string;
};

export type RestaurantInput = Omit<Restaurant, "id" | "created_at" | "updated_at">;
