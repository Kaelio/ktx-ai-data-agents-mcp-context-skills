view: orders {
  sql_table_name: public.orders ;;
  dimension: id {
    type: number
    primary_key: yes
    sql: ${TABLE}.id ;;
  }
  dimension: customer_id {
    type: number
    sql: ${TABLE}.customer_id ;;
  }
  dimension: amount {
    type: number
    sql: ${TABLE}.amount ;;
  }
  measure: gross_amount {
    type: sum
    sql: ${amount} ;;
  }
}
