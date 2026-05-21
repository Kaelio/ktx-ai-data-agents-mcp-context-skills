view: base {
  dimension: id {
    type: number
    primary_key: yes
    sql: ${TABLE}.id ;;
  }
  dimension: created_at {
    type: time
    sql: ${TABLE}.created_at ;;
  }
}
