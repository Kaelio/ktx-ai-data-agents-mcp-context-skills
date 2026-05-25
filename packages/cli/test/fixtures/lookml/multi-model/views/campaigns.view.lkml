view: campaigns {
  sql_table_name: public.campaigns ;;
  dimension: id {
    type: number
    primary_key: yes
    sql: ${TABLE}.id ;;
  }
  dimension: region_id {
    type: number
    sql: ${TABLE}.region_id ;;
  }
  measure: spend {
    type: sum
    sql: ${TABLE}.spend_cents ;;
  }
}
