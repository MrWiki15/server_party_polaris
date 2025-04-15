import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config();

const supabase = createClient(
  "https://kvcvsnvuvdoffkygnioq.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imt2Y3ZzbnZ1dmRvZmZreWduaW9xIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc0MTIxNzQyMCwiZXhwIjoyMDU2NzkzNDIwfQ.gfWFTVDFZinOl8WlOKlT3PArjV_xi5vu8NI_WpzTdig",
  {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  }
);

export default supabase;
